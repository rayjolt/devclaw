import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reviewPass } from "./review.js";
import { TestProvider } from "../../testing/test-provider.js";
import {
  DEFAULT_WORKFLOW,
  Action,
  WorkflowEvent,
} from "../../workflow/index.js";
import { PrState } from "../../providers/provider.js";

describe("heartbeat/review — terminal completion guard (human review path)", () => {
  it("blocks terminal completion and routes to To Improve when PR is conflicting (mergeable=false)", async () => {
    const provider = new TestProvider();

    // Custom workflow: approval would normally close immediately (terminal path), and we intentionally
    // omit the explicit MERGE_CONFLICT transition to ensure the shared terminal guard is doing the work.
    const workflow = structuredClone(DEFAULT_WORKFLOW);
    workflow.states.toReview.on ??= {};
    workflow.states.toReview.on[WorkflowEvent.APPROVED] = {
      target: "done",
      actions: [Action.CLOSE_ISSUE],
    };
    delete (workflow.states.toReview.on as any)[WorkflowEvent.MERGE_CONFLICT];

    provider.seedIssue({
      iid: 20,
      title: "Conflicting PR",
      labels: ["To Review", "review:human"],
    });
    provider.setPrStatus(20, {
      state: PrState.APPROVED,
      url: "https://example/pr/20",
      mergeable: false,
    });

    const n = await reviewPass({
      workspaceDir: "/tmp",
      projectName: "devclaw",
      workflow,
      provider,
      repoPath: "/tmp/repo",
      runCommand: (async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      })) as any,
    });

    assert.equal(n, 1, "should transition away from terminal completion");

    const issue = await provider.getIssue(20);
    assert.ok(
      issue.labels.includes("To Improve"),
      `labels=${issue.labels.join(",")}`,
    );
    assert.equal(issue.state, "opened");
    assert.equal(provider.callsTo("closeIssue").length, 0);
  });

  it("dedupes blocked terminal comments across ticks and posts one new comment when signature changes", async () => {
    const provider = new TestProvider();

    const workflow = structuredClone(DEFAULT_WORKFLOW);
    workflow.states.toReview.on ??= {};
    workflow.states.toReview.on[WorkflowEvent.APPROVED] = {
      target: "done",
      actions: [Action.CLOSE_ISSUE],
    };
    delete (workflow.states.toReview.on as any)[WorkflowEvent.MERGE_CONFLICT];

    provider.seedIssue({
      iid: 30,
      title: "Blocked comments",
      labels: ["To Review", "review:human"],
    });
    provider.setPrStatus(30, {
      state: PrState.APPROVED,
      url: "https://example/pr/30",
      mergeable: true,
    });

    const common = {
      workspaceDir: "/tmp",
      projectName: "devclaw",
      workflow,
      provider,
      repoPath: "/tmp/repo",
      runCommand: (async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      })) as any,
    };

    const n1 = await reviewPass(common);
    const n2 = await reviewPass(common);

    provider.setPrStatus(30, {
      state: PrState.APPROVED,
      url: "https://example/pr/30-conflict",
      mergeable: false,
    });
    const n3 = await reviewPass(common);

    assert.equal(n1, 0);
    assert.equal(n2, 0);
    assert.equal(n3, 1);

    const commentCalls = provider.callsTo("addComment");
    assert.equal(
      commentCalls.length,
      2,
      "expected one comment for unchanged block + one after signature change",
    );
    assert.notEqual(commentCalls[0]?.args.body, commentCalls[1]?.args.body);
  });

  it("blocks terminal completion when auto-merge is off and PR is not merged yet (mergeable unknown)", async () => {
    const provider = new TestProvider();

    // Custom workflow: approval would close immediately, but it has no mergePr action.
    const workflow = structuredClone(DEFAULT_WORKFLOW);
    workflow.states.toReview.on ??= {};
    workflow.states.toReview.on[WorkflowEvent.APPROVED] = {
      target: "done",
      actions: [Action.CLOSE_ISSUE],
    };

    provider.seedIssue({
      iid: 21,
      title: "Approved but not merged",
      labels: ["To Review", "review:human"],
    });
    provider.setPrStatus(21, {
      state: PrState.APPROVED,
      url: "https://example/pr/21",
      // mergeable omitted/unknown — should not be treated as conflict, but auto-merge-off + unmerged must still block.
    });

    const n = await reviewPass({
      workspaceDir: "/tmp",
      projectName: "devclaw",
      workflow,
      provider,
      repoPath: "/tmp/repo",
      runCommand: (async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      })) as any,
    });

    assert.equal(n, 0, "should not transition");

    const issue = await provider.getIssue(21);
    assert.ok(
      issue.labels.includes("To Review"),
      `labels=${issue.labels.join(",")}`,
    );
    assert.ok(!issue.labels.includes("Done"));
    assert.equal(issue.state, "opened");

    assert.equal(provider.callsTo("closeIssue").length, 0);
    assert.equal(provider.callsTo("transitionLabel").length, 0);
  });
});
