import { describe, it } from "node:test";
import assert from "node:assert";
import { executeCompletion } from "./pipeline.js";
import { createTestHarness } from "../testing/index.js";
import { DEFAULT_WORKFLOW } from "../workflow/index.js";
import {
  incrementNoChecksCounter,
  resetNoChecksCounter,
} from "./heartbeat/ci-no-checks-circuit-breaker.js";

describe("executeCompletion CI gating side-effects", () => {
  it("resets CI no-checks counter when completion closes the issue", async () => {
    const h = await createTestHarness({
      workers: {
        tester: { active: true, issueId: "26", level: "junior" },
      },
    });

    h.provider.seedIssue({
      iid: 26,
      title: "Close clears breaker",
      labels: ["Testing"],
    });

    await incrementNoChecksCounter({
      workspaceDir: h.workspaceDir,
      projectName: "test-project",
      issueId: 26,
    });

    await executeCompletion({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      channels: h.project.channels,
      role: "tester",
      result: "pass",
      issueId: 26,
      summary: "all green",
      provider: h.provider,
      repoPath: "/tmp/test-repo",
      projectName: "test-project",
      workflow: DEFAULT_WORKFLOW,
      runCommand: h.runCommand,
    });

    const wasPresent = await resetNoChecksCounter({
      workspaceDir: h.workspaceDir,
      projectName: "test-project",
      issueId: 26,
    });

    assert.strictEqual(wasPresent, false, "counter should be cleared on close");
    assert.strictEqual(h.provider.callsTo("closeIssue").length, 1);
  });

  it("does not run close/reopen actions when CI gate blocks completion", async () => {
    const h = await createTestHarness({
      workers: {
        reviewer: { active: true, issueId: "25", level: "junior" },
      },
    });

    h.provider.seedIssue({
      iid: 25,
      title: "Review PR",
      labels: ["Reviewing"],
    });
    h.provider.setPrStatus(25, {
      state: "open",
      url: "https://example.com/pr/7",
    });
    h.provider.prCiStatuses.set(25, {
      state: "pending",
      failedChecks: [],
      pendingChecks: ["build"],
    });

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
