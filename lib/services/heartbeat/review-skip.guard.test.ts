import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reviewSkipPass } from "./review-skip.js";
import { TestProvider } from "../../testing/test-provider.js";
import {
  DEFAULT_WORKFLOW,
  Action,
  WorkflowEvent,
} from "../../workflow/index.js";
import { PrState } from "../../providers/provider.js";

describe("heartbeat/review-skip — terminal completion guard comment dedupe", () => {
  it("posts at most one comment for unchanged blocked signature and one more when signature changes", async () => {
    const provider = new TestProvider();

    const workflow = structuredClone(DEFAULT_WORKFLOW);
    workflow.states.toReview.on ??= {};
    workflow.states.toReview.on[WorkflowEvent.SKIP] = {
      target: "done",
      actions: [Action.CLOSE_ISSUE],
    };

    provider.seedIssue({
      iid: 40,
      title: "Review skip blocked",
      labels: ["To Review", "review:skip"],
    });
    provider.setPrStatus(40, {
      state: PrState.APPROVED,
      url: "https://example/pr/40",
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

    const n1 = await reviewSkipPass(common);
    const n2 = await reviewSkipPass(common);

    provider.setPrStatus(40, {
      state: PrState.APPROVED,
      url: "https://example/pr/40-v2",
      mergeable: true,
    });
    const n3 = await reviewSkipPass(common);

    assert.equal(n1, 0);
    assert.equal(n2, 0);
    assert.equal(n3, 0);

    const commentCalls = provider.callsTo("addComment");
    assert.equal(commentCalls.length, 2);
    assert.notEqual(commentCalls[0]?.args.body, commentCalls[1]?.args.body);
  });
});
