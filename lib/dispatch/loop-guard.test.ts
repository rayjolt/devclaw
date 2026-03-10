import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { createTestHarness, type TestHarness } from "../testing/index.js";
import { dispatchTask } from "./index.js";
import { log as auditLog } from "../audit.js";

describe("dispatch loop guard", () => {
  let h: TestHarness;

  afterEach(async () => {
    if (h) await h.cleanup();
  });

  it("quarantines an issue instead of redispatching after repeated recent dispatches", async () => {
    h = await createTestHarness();
    h.provider.seedIssue({
      iid: 96,
      title: "Stop dispatch loops",
      labels: ["To Improve"],
    });

    for (let i = 0; i < 3; i++) {
      await auditLog(h.workspaceDir, "dispatch", {
        project: h.project.name,
        issue: 96,
        issueTitle: "Stop dispatch loops",
        role: "developer",
        level: "senior",
        sessionAction: "send",
        sessionKey: `test-${i}`,
        labelTransition: "To Improve → Doing",
      });
    }

    const result = await dispatchTask({
      workspaceDir: h.workspaceDir,
      agentId: "test-agent",
      project: h.project,
      issueId: 96,
      issueTitle: "Stop dispatch loops",
      issueDescription: "",
      issueUrl: "https://github.com/rayjolt/devclaw/issues/96",
      role: "developer",
      level: "senior",
      fromLabel: "To Improve",
      toLabel: "Doing",
      provider: h.provider,
      runCommand: h.runCommand,
    });

    const issue = await h.provider.getIssue(96);
    assert.ok(issue.labels.includes("Refining"));
    assert.ok(issue.labels.includes("workflow:desync"));
    assert.ok(!issue.labels.includes("Doing"));
    assert.match(result.announcement, /Paused issue #96/);
    assert.equal(
      h.commands.taskMessages().length,
      0,
      "should not dispatch task message after quarantine",
    );

    const comments = await h.provider.listComments(96);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /dispatch loop/i);
  });

  it("allows immediate manual requeue after a prior quarantine reset the active loop window", async () => {
    h = await createTestHarness();
    h.provider.seedIssue({
      iid: 96,
      title: "Stop dispatch loops",
      labels: ["To Improve"],
    });

    for (let i = 0; i < 3; i++) {
      await auditLog(h.workspaceDir, "dispatch", {
        project: h.project.name,
        issue: 96,
        issueTitle: "Stop dispatch loops",
        role: "developer",
        level: "senior",
        sessionAction: "send",
        sessionKey: `pre-quarantine-${i}`,
        labelTransition: "To Improve → Doing",
      });
    }

    await auditLog(h.workspaceDir, "dispatch_loop_quarantined", {
      project: h.project.name,
      issue: 96,
      issueTitle: "Stop dispatch loops",
      role: "developer",
      fromLabel: "To Improve",
      attemptedTo: "Doing",
      quarantineLabel: "Refining",
      dispatches: 3,
      windowMs: 10 * 60 * 1_000,
      commentPosted: true,
    });

    const result = await dispatchTask({
      workspaceDir: h.workspaceDir,
      agentId: "test-agent",
      project: h.project,
      issueId: 96,
      issueTitle: "Stop dispatch loops",
      issueDescription: "",
      issueUrl: "https://github.com/rayjolt/devclaw/issues/96",
      role: "developer",
      level: "senior",
      fromLabel: "To Improve",
      toLabel: "Doing",
      provider: h.provider,
      runCommand: h.runCommand,
    });

    const issue = await h.provider.getIssue(96);
    assert.ok(issue.labels.includes("Doing"));
    assert.ok(!issue.labels.includes("Refining"));
    assert.equal(h.commands.taskMessages().length, 1);
    assert.match(
      result.announcement,
      /Spawning DEVELOPER .*#96: Stop dispatch loops/,
    );
  });

  it("ignores dispatch history from other projects when checking loop thresholds", async () => {
    h = await createTestHarness();
    h.provider.seedIssue({
      iid: 96,
      title: "Stop dispatch loops",
      labels: ["To Improve"],
    });

    for (let i = 0; i < 3; i++) {
      await auditLog(h.workspaceDir, "dispatch", {
        project: "other-project",
        issue: 96,
        issueTitle: "Stop dispatch loops elsewhere",
        role: "developer",
        level: "senior",
        sessionAction: "send",
        sessionKey: `other-project-${i}`,
        labelTransition: "To Improve → Doing",
      });
    }

    const result = await dispatchTask({
      workspaceDir: h.workspaceDir,
      agentId: "test-agent",
      project: h.project,
      issueId: 96,
      issueTitle: "Stop dispatch loops",
      issueDescription: "",
      issueUrl: "https://github.com/rayjolt/devclaw/issues/96",
      role: "developer",
      level: "senior",
      fromLabel: "To Improve",
      toLabel: "Doing",
      provider: h.provider,
      runCommand: h.runCommand,
    });

    const issue = await h.provider.getIssue(96);
    assert.ok(issue.labels.includes("Doing"));
    assert.ok(!issue.labels.includes("Refining"));
    assert.ok(!issue.labels.includes("workflow:desync"));
    assert.equal(h.commands.taskMessages().length, 1);
    assert.match(
      result.announcement,
      /Spawning DEVELOPER .*#96: Stop dispatch loops/,
    );
  });

  it("does not quarantine legitimate rapid feedback cycles after successful completions", async () => {
    h = await createTestHarness();
    h.provider.seedIssue({
      iid: 96,
      title: "Stop dispatch loops",
      labels: ["To Improve"],
    });

    for (let i = 0; i < 3; i++) {
      await auditLog(h.workspaceDir, "dispatch", {
        project: h.project.name,
        issue: 96,
        issueTitle: "Stop dispatch loops",
        role: "developer",
        level: "senior",
        sessionAction: "send",
        sessionKey: `feedback-cycle-${i}`,
        labelTransition: "To Improve → Doing",
      });

      await auditLog(h.workspaceDir, "work_finish", {
        project: h.project.name,
        issue: 96,
        issueTitle: "Stop dispatch loops",
        role: "developer",
        result: "done",
        labelTransition: "Doing → Reviewing",
      });
    }

    const result = await dispatchTask({
      workspaceDir: h.workspaceDir,
      agentId: "test-agent",
      project: h.project,
      issueId: 96,
      issueTitle: "Stop dispatch loops",
      issueDescription: "",
      issueUrl: "https://github.com/rayjolt/devclaw/issues/96",
      role: "developer",
      level: "senior",
      fromLabel: "To Improve",
      toLabel: "Doing",
      provider: h.provider,
      runCommand: h.runCommand,
    });

    const issue = await h.provider.getIssue(96);
    assert.ok(issue.labels.includes("Doing"));
    assert.ok(!issue.labels.includes("Refining"));
    assert.ok(!issue.labels.includes("workflow:desync"));
    assert.equal(h.commands.taskMessages().length, 1);
    assert.match(
      result.announcement,
      /Spawning DEVELOPER .*#96: Stop dispatch loops/,
    );
  });
});
