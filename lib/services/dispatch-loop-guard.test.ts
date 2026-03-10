import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { log as auditLog } from "../audit.js";
import { DATA_DIR } from "../setup/migrate-layout.js";
import { createTestHarness } from "../testing/index.js";
import {
  countRecentDispatchesSinceLastQuarantine,
  guardDispatchLoop,
} from "./dispatch-loop-guard.js";

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

  it("counts only dispatches after the most recent quarantine event", async () => {
    const h = await createTestHarness();

    try {
      const auditDir = join(h.workspaceDir, DATA_DIR, "log");
      const auditPath = join(auditDir, "audit.log");
      const now = Date.parse("2026-03-10T12:00:00.000Z");

      await mkdir(auditDir, { recursive: true });
      await writeFile(
        auditPath,
        [
          {
            ts: "2026-03-10T11:55:00.000Z",
            event: "dispatch",
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T11:56:00.000Z",
            event: "dispatch",
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T11:57:00.000Z",
            event: "dispatch",
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T11:58:00.000Z",
            event: "dispatch_loop_quarantined",
            issue: 96,
            role: "developer",
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
        "utf-8",
      );

      const recentDispatches = await countRecentDispatchesSinceLastQuarantine({
        workspaceDir: h.workspaceDir,
        issueId: 96,
        role: "developer",
        now,
        windowMs: 10 * 60 * 1000,
      });

      assert.equal(recentDispatches, 0);
    } finally {
      await h.cleanup();
    }
  });
});
