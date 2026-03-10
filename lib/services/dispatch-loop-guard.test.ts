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

async function withMockedNow<T>(
  isoTime: string,
  run: () => Promise<T>,
): Promise<T> {
  const RealDate = Date;
  const fixedTime = RealDate.parse(isoTime);

  class MockDate extends RealDate {
    constructor(value?: string | number | Date) {
      super(value ?? fixedTime);
    }

    static override now(): number {
      return fixedTime;
    }
  }

  globalThis.Date = MockDate as DateConstructor;
  try {
    return await run();
  } finally {
    globalThis.Date = RealDate;
  }
}

describe("guardDispatchLoop", () => {
  it("quarantines a hot loop once, then allows immediate manual recovery", async () => {
    const h = await createTestHarness();

    try {
      const auditDir = join(h.workspaceDir, DATA_DIR, "log");
      const auditPath = join(auditDir, "audit.log");
      const now = Date.parse("2026-03-10T12:08:00.000Z");

      h.provider.seedIssue({
        iid: 96,
        title: "Recoverable dispatch loop",
        labels: ["To Do"],
      });

      await mkdir(auditDir, { recursive: true });
      await writeFile(
        auditPath,
        [
          {
            ts: "2026-03-10T12:01:00.000Z",
            event: "dispatch",
            project: h.project.name,
            issue: 96,
            issueTitle: "Recoverable dispatch loop",
            role: "developer",
            level: "senior",
            sessionKey: "session-0",
            labelTransition: "To Do → Doing",
          },
          {
            ts: "2026-03-10T12:02:00.000Z",
            event: "dispatch",
            project: h.project.name,
            issue: 96,
            issueTitle: "Recoverable dispatch loop",
            role: "developer",
            level: "senior",
            sessionKey: "session-1",
            labelTransition: "To Do → Doing",
          },
          {
            ts: "2026-03-10T12:03:00.000Z",
            event: "dispatch",
            project: h.project.name,
            issue: 96,
            issueTitle: "Recoverable dispatch loop",
            role: "developer",
            level: "senior",
            sessionKey: "session-2",
            labelTransition: "To Do → Doing",
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
        "utf-8",
      );

      const first = await withMockedNow("2026-03-10T12:04:00.000Z", async () =>
        guardDispatchLoop({
          workspaceDir: h.workspaceDir,
          provider: h.provider,
          projectName: h.project.name,
          issueId: 96,
          issueTitle: "Recoverable dispatch loop",
          role: "developer",
          fromLabel: "To Do",
          quarantineLabel: "Refining",
          now: Date.parse("2026-03-10T12:04:00.000Z"),
        }),
      );

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
        now,
      });

      assert.equal(second.quarantined, false);
      assert.equal(second.recentDispatches, 0);
      assert.equal(
        h.provider.callsTo("addComment").length,
        1,
        "manual recovery should not trigger a second quarantine comment",
      );

      await auditLog(h.workspaceDir, "dispatch", {
        project: h.project.name,
        issue: 96,
        issueTitle: "Recoverable dispatch loop",
        role: "developer",
        level: "senior",
        sessionKey: "session-recovered",
        labelTransition: "To Do → Doing",
      });

      const postRecoveryDispatches =
        await countRecentDispatchesSinceLastQuarantine({
          workspaceDir: h.workspaceDir,
          projectName: h.project.name,
          issueId: 96,
          role: "developer",
        });

      assert.equal(
        postRecoveryDispatches,
        1,
        "dispatch counting should restart from zero after quarantine so immediate requeue can recover",
      );
    } finally {
      await h.cleanup();
    }
  });

  it("counts only dispatches after the most recent quarantine timestamp", async () => {
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
            project: h.project.name,
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T11:56:00.000Z",
            event: "dispatch",
            project: h.project.name,
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T11:57:00.000Z",
            event: "dispatch",
            project: h.project.name,
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T11:54:00.000Z",
            event: "dispatch_loop_quarantined",
            project: h.project.name,
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
        projectName: h.project.name,
        issueId: 96,
        role: "developer",
        now,
        windowMs: 10 * 60 * 1000,
      });

      assert.equal(recentDispatches, 3);
    } finally {
      await h.cleanup();
    }
  });

  it("ignores dispatches that happened before a later quarantine even if the log lines are out of order", async () => {
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
            ts: "2026-03-10T11:57:00.000Z",
            event: "dispatch",
            project: h.project.name,
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T11:58:00.000Z",
            event: "dispatch",
            project: h.project.name,
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T11:59:00.000Z",
            event: "dispatch_loop_quarantined",
            project: h.project.name,
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T11:56:00.000Z",
            event: "dispatch",
            project: h.project.name,
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
        projectName: h.project.name,
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

  it("ignores dispatches and quarantine events from other projects with the same issue and role", async () => {
    const h = await createTestHarness();

    try {
      const auditDir = join(h.workspaceDir, DATA_DIR, "log");
      const auditPath = join(auditDir, "audit.log");
      const now = Date.parse("2026-03-10T12:08:00.000Z");

      h.provider.seedIssue({
        iid: 96,
        title: "Project-scoped dispatch loop",
        labels: ["To Do"],
      });

      await mkdir(auditDir, { recursive: true });
      await writeFile(
        auditPath,
        [
          {
            ts: "2026-03-10T12:02:00.000Z",
            event: "dispatch_loop_quarantined",
            project: "other-project",
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T12:05:00.000Z",
            event: "dispatch",
            project: "other-project",
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T12:06:00.000Z",
            event: "dispatch",
            project: "other-project",
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T12:07:00.000Z",
            event: "dispatch",
            project: "other-project",
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T12:04:00.000Z",
            event: "dispatch",
            project: h.project.name,
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
        projectName: h.project.name,
        issueId: 96,
        role: "developer",
        now,
        windowMs: 10 * 60 * 1000,
      });

      assert.equal(
        recentDispatches,
        1,
        "only dispatches from the current project should count",
      );

      const result = await guardDispatchLoop({
        workspaceDir: h.workspaceDir,
        provider: h.provider,
        projectName: h.project.name,
        issueId: 96,
        issueTitle: "Project-scoped dispatch loop",
        role: "developer",
        fromLabel: "To Do",
        quarantineLabel: "Refining",
        now,
      });

      assert.equal(result.quarantined, false);
      assert.equal(result.recentDispatches, 1);
      assert.equal(h.provider.callsTo("transitionLabel").length, 0);
      assert.equal(h.provider.callsTo("addComment").length, 0);
    } finally {
      await h.cleanup();
    }
  });

  it("ignores dispatches from other projects with the same issue id and role", async () => {
    const h = await createTestHarness();

    try {
      const auditDir = join(h.workspaceDir, DATA_DIR, "log");
      const auditPath = join(auditDir, "audit.log");
      const now = Date.parse("2026-03-10T12:08:00.000Z");

      h.provider.seedIssue({
        iid: 96,
        title: "Project-scoped dispatch loop",
        labels: ["To Do"],
      });

      await mkdir(auditDir, { recursive: true });
      await writeFile(
        auditPath,
        [
          {
            ts: "2026-03-10T12:05:00.000Z",
            event: "dispatch",
            project: "other-project",
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T12:06:00.000Z",
            event: "dispatch",
            project: "other-project",
            issue: 96,
            role: "developer",
          },
          {
            ts: "2026-03-10T12:07:00.000Z",
            event: "dispatch",
            project: "other-project",
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
        projectName: h.project.name,
        issueId: 96,
        role: "developer",
        now,
      });

      assert.equal(recentDispatches, 0);

      const result = await guardDispatchLoop({
        workspaceDir: h.workspaceDir,
        provider: h.provider,
        projectName: h.project.name,
        issueId: 96,
        issueTitle: "Project-scoped dispatch loop",
        role: "developer",
        fromLabel: "To Do",
        quarantineLabel: "Refining",
        now,
      });

      assert.equal(result.quarantined, false);
      assert.equal(result.recentDispatches, 0);

      const issue = await h.provider.getIssue(96);
      assert.deepEqual(issue.labels, ["To Do"]);
      assert.equal(h.provider.callsTo("addComment").length, 0);
    } finally {
      await h.cleanup();
    }
  });
});
