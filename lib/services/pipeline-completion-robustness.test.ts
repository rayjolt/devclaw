import { describe, it } from "node:test";
import assert from "node:assert";
import { executeCompletion } from "./pipeline.js";
import { createTestHarness } from "../testing/index.js";

describe("executeCompletion transition robustness", () => {
  it("retries transient provider transition failures and succeeds", async () => {
    const h = await createTestHarness({
      workers: {
        developer: { active: true, issueId: "18", level: "senior" },
      },
    });

    h.provider.seedIssue({
      iid: 18,
      title: "Retry transition",
      labels: ["Doing"],
    });

    let attempts = 0;
    const original = h.provider.transitionLabel.bind(h.provider);
    h.provider.transitionLabel = async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new Error("provider temporarily unavailable");
      return original(...args);
    };

    const out = await executeCompletion({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      channels: h.project.channels,
      role: "developer",
      result: "done",
      issueId: 18,
      summary: "done",
      provider: h.provider,
      repoPath: "/tmp/test-repo",
      projectName: "test-project",
      runCommand: h.runCommand,
    });

    assert.strictEqual(out.labelTransition, "Doing → To Review");
    assert.strictEqual(out.transitionAttempts, 2);
    assert.ok(out.correlationId.length > 0);

    const issue = await h.provider.getIssue(18);
    assert.ok(issue.labels.includes("To Review"));
  });

  it("fails explicitly when transition reports success but target label is missing", async () => {
    const h = await createTestHarness({
      workers: {
        developer: { active: true, issueId: "19", level: "senior" },
      },
    });

    h.provider.seedIssue({
      iid: 19,
      title: "Phantom completion",
      labels: ["Doing"],
    });

    h.provider.transitionLabel = async () => {
      // no-op: simulates provider call succeeding but state not actually transitioning
    };

    await assert.rejects(
      executeCompletion({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        channels: h.project.channels,
        role: "developer",
        result: "done",
        issueId: 19,
        summary: "done",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
        runCommand: h.runCommand,
      }),
      /Completion transition failed.*after 3 attempts/,
    );

    const projects = await h.readProjects();
    const slot =
      projects.projects[h.project.slug]!.workers.developer!.levels.senior![0]!;
    assert.strictEqual(
      slot.active,
      true,
      "worker should stay active when completion transition fails",
    );

    const issue = await h.provider.getIssue(19);
    assert.ok(
      issue.labels.includes("Doing"),
      `labels=${issue.labels.join(",")}`,
    );
  });

  it("allows idempotent retry when label already transitioned", async () => {
    const h = await createTestHarness({
      workers: {
        developer: { active: true, issueId: "20", level: "senior" },
      },
    });

    h.provider.seedIssue({
      iid: 20,
      title: "Already transitioned",
      labels: ["To Review"],
    });

    const out = await executeCompletion({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      channels: h.project.channels,
      role: "developer",
      result: "done",
      issueId: 20,
      summary: "retry",
      provider: h.provider,
      repoPath: "/tmp/test-repo",
      projectName: "test-project",
      runCommand: h.runCommand,
    });

    assert.strictEqual(out.transitionAttempts, 0);
    assert.strictEqual(h.provider.callsTo("transitionLabel").length, 0);

    const projects = await h.readProjects();
    const slot =
      projects.projects[h.project.slug]!.workers.developer!.levels.senior![0]!;
    assert.strictEqual(
      slot.active,
      false,
      "retry path should still finalize worker deactivation",
    );
  });

  it("fails fast on stale/mismatched state precondition", async () => {
    const h = await createTestHarness({
      workers: {
        developer: { active: true, issueId: "21", level: "senior" },
      },
    });

    // Worker thinks it is completing Doing, but issue is no longer in Doing.
    h.provider.seedIssue({
      iid: 21,
      title: "Mismatched state",
      labels: ["To Do"],
    });

    await assert.rejects(
      executeCompletion({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        channels: h.project.channels,
        role: "developer",
        result: "done",
        issueId: 21,
        summary: "done",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
        runCommand: h.runCommand,
      }),
      /precondition failed/,
    );

    assert.strictEqual(h.provider.callsTo("transitionLabel").length, 0);
  });
});
