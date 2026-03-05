import { describe, it } from "node:test";
import assert from "node:assert";
import { executeCompletion } from "./pipeline.js";
import { createTestHarness } from "../testing/index.js";

// Regression: pipeline completion must never execute terminal side effects
// (especially closeIssue) when the shared terminal guard blocks.

describe("executeCompletion terminal guard (pipeline)", () => {
  it("does not close issue when PR is conflicting (mergeable=false)", async () => {
    const h = await createTestHarness({
      workers: {
        tester: { active: true, issueId: "34", level: "senior" },
      },
    });

    h.provider.seedIssue({
      iid: 34,
      title: "Conflicting PR should block terminal completion",
      labels: ["Testing"],
    });

    h.provider.setPrStatus(34, {
      state: "open",
      url: "https://example.com/pr/34",
      mergeable: false,
    });

    const out = await executeCompletion({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      channels: h.project.channels,
      role: "tester",
      result: "pass",
      issueId: 34,
      summary: "pass",
      provider: h.provider,
      repoPath: "/tmp/test-repo",
      projectName: "test-project",
      runCommand: h.runCommand,
    });

    assert.strictEqual(out.labelTransition, "Testing → To Improve");
    assert.strictEqual(h.provider.callsTo("closeIssue").length, 0);

    const issue = await h.provider.getIssue(34);
    assert.strictEqual(issue.state, "opened");
    assert.ok(
      issue.labels.includes("To Improve"),
      `labels=${issue.labels.join(",")}`,
    );
  });

  it("does not close issue when auto-merge is off and PR is not merged", async () => {
    const h = await createTestHarness({
      workers: {
        tester: { active: true, issueId: "35", level: "senior" },
      },
    });

    h.provider.seedIssue({
      iid: 35,
      title:
        "Unmerged PR should block terminal completion when auto-merge is off",
      labels: ["Testing"],
    });

    // mergeable unknown/true should not matter; without mergePr in the action list,
    // terminal completion must wait for provider to report PR merged.
    h.provider.setPrStatus(35, {
      state: "open",
      url: "https://example.com/pr/35",
      mergeable: true,
    });

    const out = await executeCompletion({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      channels: h.project.channels,
      role: "tester",
      result: "pass",
      issueId: 35,
      summary: "pass",
      provider: h.provider,
      repoPath: "/tmp/test-repo",
      projectName: "test-project",
      runCommand: h.runCommand,
    });

    const out2 = await executeCompletion({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      channels: h.project.channels,
      role: "tester",
      result: "pass",
      issueId: 35,
      summary: "pass (repeat)",
      provider: h.provider,
      repoPath: "/tmp/test-repo",
      projectName: "test-project",
      runCommand: h.runCommand,
    });

    // Guard blocks without suggesting a state change; pipeline stays put.
    assert.strictEqual(out.labelTransition, "Testing → Testing");
    assert.strictEqual(out2.labelTransition, "Testing → Testing");
    assert.strictEqual(h.provider.callsTo("closeIssue").length, 0);
    assert.strictEqual(
      h.provider.callsTo("addComment").length,
      1,
      "expected deduped blocked-terminal comment for same issueId/reason/prUrl signature",
    );
    assert.match(
      h.provider.callsTo("addComment")[0]!.args.body,
      /<!-- devclaw:terminal-completion-blocked:35\|pr_not_merged_auto_merge_off\|https:\/\/example\.com\/pr\/35 -->/,
    );

    const issue = await h.provider.getIssue(35);
    assert.strictEqual(issue.state, "opened");
    assert.ok(
      issue.labels.includes("Testing"),
      `labels=${issue.labels.join(",")}`,
    );
  });
});
