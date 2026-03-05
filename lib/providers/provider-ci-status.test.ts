import { describe, it } from "node:test";
import assert from "node:assert";
import type { RunCommand } from "../context.js";
import { GitHubProvider } from "./github.js";
import { CiState } from "./provider.js";

function rcFor(payloads: Record<string, unknown>): RunCommand {
  return (async (command: string[]) => {
    const joined = command.join(" ");
    if (joined.includes("check-runs")) {
      return { stdout: JSON.stringify(payloads.checkRuns ?? {}), stderr: "", exitCode: 0, code: 0, signal: null, killed: false, termination: "exit" } as any;
    }
    if (joined.includes("/status")) {
      return { stdout: JSON.stringify(payloads.statuses ?? {}), stderr: "", exitCode: 0, code: 0, signal: null, killed: false, termination: "exit" } as any;
    }
    throw new Error(`Unexpected command: ${joined}`);
  }) as RunCommand;
}

describe("GitHubProvider.getPrCiStatus", () => {
  it("returns pending when checks are running", async () => {
    const p = new GitHubProvider({ repoPath: "/fake", runCommand: rcFor({ checkRuns: { check_runs: [{ name: "build", status: "in_progress", conclusion: null }] } }) });
    (p as any).findPrsForIssue = async () => [{ title: "t", body: "b", number: 1, url: "u", headRefOid: "abc" }];
    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.PENDING);
    assert.ok(ci.pendingChecks.includes("build"));
  });

  it("returns fail when check conclusion fails", async () => {
    const p = new GitHubProvider({ repoPath: "/fake", runCommand: rcFor({ checkRuns: { check_runs: [{ name: "test", status: "completed", conclusion: "failure" }] } }) });
    (p as any).findPrsForIssue = async () => [{ title: "t", body: "b", number: 1, url: "u", headRefOid: "abc" }];
    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.FAIL);
    assert.ok(ci.failedChecks.includes("test"));
  });

  it("ignores neutral/skipped and returns pass when all checks succeed", async () => {
    const p = new GitHubProvider({ repoPath: "/fake", runCommand: rcFor({ checkRuns: { check_runs: [
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "optional", status: "completed", conclusion: "neutral" },
      { name: "flaky", status: "completed", conclusion: "skipped" },
    ] } }) });
    (p as any).findPrsForIssue = async () => [{ title: "t", body: "b", number: 1, url: "u", headRefOid: "abc" }];
    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.PASS);
  });

  it("returns unknown when no checks are reported (fail-closed policy)", async () => {
    const p = new GitHubProvider({ repoPath: "/fake", runCommand: rcFor({ checkRuns: { check_runs: [] }, statuses: { statuses: [] } }) });
    (p as any).findPrsForIssue = async () => [{ title: "t", body: "b", number: 1, url: "u", headRefOid: "abc" }];
    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.UNKNOWN);
  });

  it("retries transient missing headRefOid and reports concrete failing checks", async () => {
    const p = new GitHubProvider({
      repoPath: "/fake",
      runCommand: rcFor({
        checkRuns: { check_runs: [{ name: "quality", status: "completed", conclusion: "failure" }] },
      }),
    });
    let prCalls = 0;
    (p as any).findPrsForIssue = async () => {
      prCalls++;
      if (prCalls === 1) return [{ title: "t", body: "b", number: 1, url: "u", headRefOid: "" }];
      return [{ title: "t", body: "b", number: 1, url: "u", headRefOid: "abc" }];
    };

    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.FAIL);
    assert.ok(ci.failedChecks.includes("quality"));
    assert.ok(prCalls >= 2);
  });
});
