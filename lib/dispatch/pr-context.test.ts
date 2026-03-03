import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatPrFeedback, type PrFeedback } from "./pr-context.js";

describe("formatPrFeedback", () => {
  it("returns empty array when no comments", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/123",
      branchName: "feature/123-test",
      reason: "merge_conflict",
      comments: [],
    };
    const result = formatPrFeedback(feedback, "main");
    assert.deepEqual(result, []);
  });

  it("includes branch name in conflict resolution instructions", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/123",
      branchName: "feature/456-test",
      reason: "merge_conflict",
      comments: [
        {
          id: 1,
          author: "reviewer",
          body: "Conflicts detected",
          state: "COMMENTED",
        },
      ],
    };
    const result = formatPrFeedback(feedback, "main");
    const text = result.join("\n");

    assert.ok(text.includes("feature/456-test"));
    assert.ok(text.includes("🔹 Branch: `feature/456-test`"));
    assert.ok(text.includes("git checkout feature/456-test"));
    assert.ok(text.includes("git push --force-with-lease origin feature/456-test"));
  });

  it("uses fallback branch name when not provided", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/123",
      reason: "merge_conflict",
      comments: [
        {
          id: 1,
          author: "reviewer",
          body: "Conflicts detected",
          state: "COMMENTED",
        },
      ],
    };
    const result = formatPrFeedback(feedback, "main");
    const text = result.join("\n");

    assert.ok(text.includes("your-branch"));
    assert.ok(text.includes("🔹 Branch: `your-branch`"));
  });

  it("includes step-by-step instructions for conflict resolution", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/123",
      branchName: "feature/123-fix",
      reason: "merge_conflict",
      comments: [
        {
          id: 1,
          author: "reviewer",
          body: "Fix the conflicts",
          state: "COMMENTED",
        },
      ],
    };
    const result = formatPrFeedback(feedback, "develop");
    const text = result.join("\n");

    assert.ok(text.includes("1. Fetch and check out the PR branch"));
    assert.ok(text.includes("2. Rebase onto `develop`"));
    assert.ok(text.includes("3. Resolve any conflicts"));
    assert.ok(text.includes("4. Force-push to the SAME branch"));
    assert.ok(text.includes("5. Verify the PR shows as mergeable"));

    assert.ok(text.includes("⚠️ Do NOT create a new PR"));
    assert.ok(text.includes("Do NOT switch branches"));
    assert.ok(text.includes("Update THIS PR only"));
  });

  it("correctly formats changes_requested feedback", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/456",
      branchName: "feature/789-feature",
      reason: "changes_requested",
      comments: [
        {
          id: 1,
          author: "reviewer",
          body: "Please make these changes",
          state: "CHANGES_REQUESTED",
        },
      ],
    };
    const result = formatPrFeedback(feedback, "main");
    const text = result.join("\n");

    assert.ok(text.includes("⚠️ Changes were requested"));
    assert.ok(text.includes("Please make these changes"));
    assert.ok(!text.includes("Conflict Resolution Instructions"));
  });

  it("includes comment location information when available", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/123",
      branchName: "feature/456-test",
      reason: "changes_requested",
      comments: [
        {
          id: 1,
          author: "reviewer",
          body: "Fix this logic",
          state: "CHANGES_REQUESTED",
          path: "src/index.ts",
          line: 42,
        },
      ],
    };
    const result = formatPrFeedback(feedback, "main");
    const text = result.join("\n");

    assert.ok(text.includes("(src/index.ts:42)"));
  });

  it("uses correct base branch in rebase command", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/123",
      branchName: "feature/test",
      reason: "merge_conflict",
      comments: [
        {
          id: 1,
          author: "reviewer",
          body: "Conflicts",
          state: "COMMENTED",
        },
      ],
    };

    let result = formatPrFeedback(feedback, "main");
    let text = result.join("\n");
    assert.ok(text.includes("git rebase main"));

    result = formatPrFeedback(feedback, "develop");
    text = result.join("\n");
    assert.ok(text.includes("git rebase develop"));
  });
});
