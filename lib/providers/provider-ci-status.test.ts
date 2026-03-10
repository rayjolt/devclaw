import { describe, it } from "node:test";
import assert from "node:assert";
import type { RunCommand } from "../context.js";
import { GitHubProvider } from "./github.js";
import { CiState } from "./provider.js";

function rcFor(payloads: Record<string, unknown>): RunCommand {
  return (async (command: string[]) => {
    const joined = command.join(" ");
    if (joined.includes("check-runs")) {
      return {
        stdout: JSON.stringify(payloads.checkRuns ?? {}),
        stderr: "",
        exitCode: 0,
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      } as any;
    }
    if (joined.includes("/status")) {
      return {
        stdout: JSON.stringify(payloads.statuses ?? {}),
        stderr: "",
        exitCode: 0,
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      } as any;
    }
    throw new Error(`Unexpected command: ${joined}`);
  }) as RunCommand;
}

describe("GitHubProvider.getPrCiStatus", () => {
  it("returns pending when checks are running", async () => {
    const p = new GitHubProvider({
      repoPath: "/fake",
      runCommand: rcFor({
        checkRuns: {
          check_runs: [
            { name: "build", status: "in_progress", conclusion: null },
          ],
        },
      }),
    });
    (p as any).findPrsForIssue = async () => [
      { title: "t", body: "b", number: 1, url: "u", headRefOid: "abc" },
    ];
    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.PENDING);
    assert.ok(ci.pendingChecks.includes("build"));
  });

  it("returns fail when check conclusion fails", async () => {
    const p = new GitHubProvider({
      repoPath: "/fake",
      runCommand: rcFor({
        checkRuns: {
          check_runs: [
            { name: "test", status: "completed", conclusion: "failure" },
          ],
        },
      }),
    });
    (p as any).findPrsForIssue = async () => [
      { title: "t", body: "b", number: 1, url: "u", headRefOid: "abc" },
    ];
    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.FAIL);
    assert.ok(ci.failedChecks.includes("test"));
  });

  it("ignores neutral/skipped and returns pass when all checks succeed", async () => {
    const p = new GitHubProvider({
      repoPath: "/fake",
      runCommand: rcFor({
        checkRuns: {
          check_runs: [
            { name: "lint", status: "completed", conclusion: "success" },
            { name: "optional", status: "completed", conclusion: "neutral" },
            { name: "flaky", status: "completed", conclusion: "skipped" },
          ],
        },
      }),
    });
    (p as any).findPrsForIssue = async () => [
      { title: "t", body: "b", number: 1, url: "u", headRefOid: "abc" },
    ];
    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.PASS);
  });

  it("returns unknown when no checks are reported (fail-closed policy)", async () => {
    const p = new GitHubProvider({
      repoPath: "/fake",
      runCommand: rcFor({
        checkRuns: { check_runs: [] },
        statuses: { statuses: [] },
      }),
    });
    (p as any).findPrsForIssue = async () => [
      { title: "t", body: "b", number: 1, url: "u", headRefOid: "abc" },
    ];
    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.UNKNOWN);
  });

  it("retries transient missing PR head SHA and reports failing checks", async () => {
    const p = new GitHubProvider({
      repoPath: "/fake",
      runCommand: rcFor({
        checkRuns: {
          check_runs: [
            { name: "quality", status: "completed", conclusion: "failure" },
          ],
        },
      }),
    });
    let calls = 0;
    (p as any).findPrsForIssue = async () => {
      calls++;
      if (calls === 1)
        return [{ title: "t", body: "b", number: 1, url: "u", headRefOid: "" }];
      return [
        { title: "t", body: "b", number: 1, url: "u", headRefOid: "abc" },
      ];
    };

    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.FAIL);
    assert.ok(ci.failedChecks.includes("quality"));
    assert.ok(calls >= 2);
  });

  it("uses headRefOid from timeline PR metadata for CI lookup", async () => {
    const p = new GitHubProvider({
      repoPath: "/fake",
      runCommand: rcFor({
        checkRuns: {
          check_runs: [
            { name: "quality", status: "completed", conclusion: "failure" },
          ],
        },
      }),
    });
    (p as any).findPrsViaTimeline = async () => [
      {
        number: 1,
        title: "t",
        body: "b",
        headRefName: "feature/90-ci-gate-diagnostics",
        headRefOid: "abc",
        url: "u",
        mergedAt: null,
        reviewDecision: null,
        state: "OPEN",
        mergeable: "MERGEABLE",
      },
    ];

    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.FAIL);
    assert.ok(ci.failedChecks.includes("quality"));
  });

  it("uses merged PR head SHA when no open PR exists", async () => {
    const p = new GitHubProvider({
      repoPath: "/fake",
      runCommand: rcFor({
        checkRuns: {
          check_runs: [
            { name: "post-merge", status: "completed", conclusion: "success" },
          ],
        },
      }),
    });

    (p as any).findPrsForIssue = async (_issueId: number, state: string) => {
      if (state === "merged") {
        return [
          {
            title: "t",
            body: "b",
            number: 2,
            url: "u",
            headRefOid: "merged-sha",
            mergedAt: "2026-03-09T12:00:00Z",
          },
        ];
      }
      return [];
    };

    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.PASS);
  });

  it("prefers merged PR CI over open PR CI when both are present", async () => {
    const seenStates: string[] = [];
    const p = new GitHubProvider({
      repoPath: "/fake",
      runCommand: rcFor({
        checkRuns: {
          check_runs: [
            {
              name: "merged-check",
              status: "completed",
              conclusion: "failure",
            },
          ],
        },
      }),
    });

    (p as any).findPrsForIssue = async (_issueId: number, state: string) => {
      seenStates.push(state);
      if (state === "merged") {
        return [
          {
            title: "merged",
            body: "b",
            number: 3,
            url: "merged-url",
            headRefOid: "merged-sha",
            mergedAt: "2026-03-09T12:00:00Z",
          },
        ];
      }
      if (state === "open") {
        return [
          {
            title: "open",
            body: "b",
            number: 4,
            url: "open-url",
            headRefOid: "open-sha",
          },
        ];
      }
      return [];
    };

    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.FAIL);
    assert.ok(ci.failedChecks.includes("merged-check"));
    assert.deepStrictEqual(seenStates, ["merged"]);
  });

  it("preserves unknown status when no open or merged PR exists", async () => {
    const p = new GitHubProvider({ repoPath: "/fake", runCommand: rcFor({}) });
    const seenStates: string[] = [];

    (p as any).findPrsForIssue = async (_issueId: number, state: string) => {
      seenStates.push(state);
      return [];
    };

    const ci = await p.getPrCiStatus(1);
    assert.strictEqual(ci.state, CiState.UNKNOWN);
    assert.strictEqual(ci.summary, "No open PR found for CI status");
    assert.deepStrictEqual(seenStates, ["merged", "open"]);
  });
});
