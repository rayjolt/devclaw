import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RunCommand } from "../context.js";
import { GitHubProvider } from "./github.js";

describe("GitHubProvider.listComments", () => {
  it("uses gh api pagination and returns stably sorted comments", async () => {
    const calls: string[][] = [];
    const runCommand: RunCommand = async (args) => {
      calls.push(args);
      return {
        stdout: [
          JSON.stringify({
            id: 202,
            author: "zoe",
            body: "second page marker",
            created_at: "2026-03-01T10:00:00Z",
          }),
          JSON.stringify({
            id: 101,
            author: "alice",
            body: "first page",
            created_at: "2026-03-01T09:00:00Z",
          }),
        ].join("\n"),
        stderr: "",
        exitCode: 0,
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      } as any;
    };

    const provider = new GitHubProvider({ repoPath: "/fake", runCommand });
    const comments = await provider.listComments(42);

    const ghCall = calls.find((c) => c[0] === "gh" && c[1] === "api");
    assert.ok(ghCall, "expected gh api call");
    assert.ok(
      ghCall?.includes("--paginate"),
      "expected --paginate for full comment retrieval",
    );

    assert.equal(comments.length, 2);
    assert.equal(
      comments[0]?.id,
      101,
      "expected stable chronological ordering",
    );
    assert.equal(comments[1]?.id, 202);
  });
});
