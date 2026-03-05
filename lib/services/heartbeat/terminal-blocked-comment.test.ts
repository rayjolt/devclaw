import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { postTerminalBlockedCommentOnce } from "../terminal-blocked-comment.js";

describe("postTerminalBlockedCommentOnce", () => {
  it("dedupes when signature marker exists outside the first page of comments", async () => {
    const marker =
      "<!-- devclaw:terminal-completion-blocked:30|merge_conflict|https://example/pr/30 -->";
    const comments = Array.from({ length: 120 }, (_, i) => ({
      id: i + 1,
      author: "user",
      body: i === 95 ? `existing note\n\n${marker}` : `noise comment ${i + 1}`,
      created_at: new Date(2026, 0, 1, 0, i).toISOString(),
    }));

    let addCommentCalls = 0;
    const provider = {
      listComments: async () => comments,
      addComment: async () => {
        addCommentCalls += 1;
        return 999;
      },
    } as any;

    const posted = await postTerminalBlockedCommentOnce({
      provider,
      issueId: 30,
      reason: "merge_conflict",
      prUrl: "https://example/pr/30",
    });

    assert.equal(posted, false);
    assert.equal(
      addCommentCalls,
      0,
      "should not post duplicate marker comment",
    );
  });
});
