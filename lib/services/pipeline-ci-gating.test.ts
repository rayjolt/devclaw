import { describe, it } from "node:test";
import assert from "node:assert";
import { executeCompletion } from "./pipeline.js";
import { createTestHarness } from "../testing/index.js";
import { DEFAULT_WORKFLOW } from "../workflow/index.js";

describe("executeCompletion CI gating side-effects", () => {
  it("does not run close/reopen actions when CI gate blocks completion", async () => {
    const h = await createTestHarness({
      workers: {
        reviewer: { active: true, issueId: "25", level: "junior" },
      },
    });

    h.provider.seedIssue({ iid: 25, title: "Review PR", labels: ["Reviewing"] });
    h.provider.setPrStatus(25, { state: "open", url: "https://example.com/pr/7" });
    h.provider.prCiStatuses.set(25, { state: "pending", failedChecks: [], pendingChecks: ["build"] });

    const workflow = structuredClone(DEFAULT_WORKFLOW);
    workflow.ciGating = true;
    workflow.states.reviewing!.on!.APPROVE = {
      target: "toTest",
      actions: ["mergePr", "closeIssue", "reopenIssue"],
    };

    const output = await executeCompletion({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      channels: h.project.channels,
      role: "reviewer",
      result: "approve",
      issueId: 25,
      summary: "LGTM",
      provider: h.provider,
      repoPath: "/tmp/test-repo",
      projectName: "test-project",
      workflow,
      runCommand: h.runCommand,
    });

    assert.strictEqual(output.labelTransition, "Reviewing → Reviewing");
    assert.strictEqual(output.issueClosed, false);
    assert.strictEqual(output.issueReopened, false);
    assert.strictEqual(h.provider.callsTo("closeIssue").length, 0);
    assert.strictEqual(h.provider.callsTo("reopenIssue").length, 0);
  });
});
