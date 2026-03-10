import { describe, it } from "node:test";
import assert from "node:assert";
import type { RunCommand } from "../context.js";
import { GitHubProvider } from "./github.js";

function ok(stdout: string): any {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

describe("GitHubProvider repo arg scoping", () => {
  it("does not rewrite gh auth status with a repo flag", async () => {
    const commands: string[][] = [];
    const runCommand = (async (command: string[]) => {
      commands.push(command);
      return ok("github.com\n  ✓ Logged in");
    }) as RunCommand;
    const provider = new GitHubProvider({
      repoPath: "/fake",
      repoRemote: "git@github.com:octo-org/platform.git",
      runCommand,
    });

    const healthy = await provider.healthCheck();

    assert.strictEqual(healthy, true);
    assert.deepStrictEqual(commands, [["gh", "auth", "status"]]);
  });

  it("binds repo-scoped issue commands to the configured remote", async () => {
    const commands: string[][] = [];
    const runCommand = (async (command: string[]) => {
      commands.push(command);
      return ok(JSON.stringify({
        number: 7,
        title: "Issue",
        body: "Body",
        labels: [],
        state: "OPEN",
        url: "https://github.com/octo-org/platform/issues/7",
      }));
    }) as RunCommand;
    const provider = new GitHubProvider({
      repoPath: "/fake",
      repoRemote: "https://github.com/octo-org/platform.git",
      runCommand,
    });

    await provider.getIssue(7);

    assert.deepStrictEqual(commands, [[
      "gh",
      "issue",
      "view",
      "7",
      "--json",
      "number,title,body,labels,state,url",
      "--repo",
      "octo-org/platform",
    ]]);
  });
});
