import { describe, it } from "node:test";
import assert from "node:assert";
import { reviewPass } from "./review.js";
import { TestProvider } from "../../testing/test-provider.js";
import { DEFAULT_WORKFLOW } from "../../workflow/index.js";
import { CiState, PrState } from "../../providers/provider.js";

describe("reviewPass CI gating", () => {
  it("keeps issue in To Review while CI is pending", async () => {
    const provider = new TestProvider();
    provider.seedIssue({ iid: 10, title: "CI pending", labels: ["To Review", "review:human"] });
    provider.setPrStatus(10, { state: PrState.APPROVED, url: "https://example/pr/10" });
    provider.prCiStatuses.set(10, { state: CiState.PENDING, failedChecks: [], pendingChecks: ["build"] });

    const transitions = await reviewPass({
      workspaceDir: "/tmp",
      projectName: "devclaw",
      workflow: { ...DEFAULT_WORKFLOW, ciGating: true },
      provider,
      repoPath: "/tmp/repo",
      runCommand: (async () => ({ stdout: "", stderr: "", exitCode: 0, code: 0, signal: null, killed: false, termination: "exit" })) as any,
    });

    const issue = await provider.getIssue(10);
    assert.strictEqual(transitions, 0);
    assert.ok(issue.labels.includes("To Review"));
  });

  it("routes to To Improve when CI fails", async () => {
    const provider = new TestProvider();
    provider.seedIssue({ iid: 11, title: "CI fail", labels: ["To Review", "review:human"] });
    provider.setPrStatus(11, { state: PrState.APPROVED, url: "https://example/pr/11" });
    provider.prCiStatuses.set(11, { state: CiState.FAIL, failedChecks: ["test"], pendingChecks: [] });

    const transitions = await reviewPass({
      workspaceDir: "/tmp",
      projectName: "devclaw",
      workflow: { ...DEFAULT_WORKFLOW, ciGating: true },
      provider,
      repoPath: "/tmp/repo",
      runCommand: (async () => ({ stdout: "", stderr: "", exitCode: 0, code: 0, signal: null, killed: false, termination: "exit" })) as any,
    });

    const issue = await provider.getIssue(11);
    assert.strictEqual(transitions, 1);
    assert.ok(issue.labels.includes("To Improve"), `labels=${issue.labels.join(",")}`);
  });
});
