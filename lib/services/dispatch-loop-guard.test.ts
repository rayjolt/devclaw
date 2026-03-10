import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { log as auditLog } from "../audit.js";
import { createTestHarness } from "../testing/index.js";
import { guardDispatchLoop } from "./dispatch-loop-guard.js";

describe("guardDispatchLoop", () => {
  it("quarantines a hot loop once, then allows immediate manual recovery", async () => {
    const h = await createTestHarness();

    try {
      h.provider.seedIssue({
        iid: 96,
        title: "Recoverable dispatch loop",
        labels: ["To Do"],
      });

      for (let i = 0; i < 3; i++) {
        await auditLog(h.workspaceDir, "dispatch", {
          project: h.project.name,
          issue: 96,
          issueTitle: "Recoverable dispatch loop",
          role: "developer",
          level: "senior",
          sessionKey: `session-${i}`,
          labelTransition: "To Do → Doing",
        });
      }

      const first = await guardDispatchLoop({
        workspaceDir: h.workspaceDir,
        provider: h.provider,
        projectName: h.project.name,
        issueId: 96,
        issueTitle: "Recoverable dispatch loop",
        role: "developer",
        fromLabel: "To Do",
        quarantineLabel: "Refining",
      });

      assert.equal(first.quarantined, true);

      const quarantinedIssue = await h.provider.getIssue(96);
      assert.ok(quarantinedIssue.labels.includes("Refining"));
      assert.ok(quarantinedIssue.labels.includes("workflow:desync"));
      assert.equal(h.provider.callsTo("addComment").length, 1);

      // Simulate operator reconciliation + immediate requeue.
      await h.provider.transitionLabel(96, "Refining", "To Do");

      const second = await guardDispatchLoop({
        workspaceDir: h.workspaceDir,
        provider: h.provider,
        projectName: h.project.name,
        issueId: 96,
        issueTitle: "Recoverable dispatch loop",
        role: "developer",
        fromLabel: "To Do",
        quarantineLabel: "Refining",
      });

      assert.equal(second.quarantined, false);
      assert.equal(second.recentDispatches, 0);
      assert.equal(
        h.provider.callsTo("addComment").length,
        1,
        "manual recovery should not trigger a second quarantine comment",
      );
    } finally {
      await h.cleanup();
    }
  });
});
