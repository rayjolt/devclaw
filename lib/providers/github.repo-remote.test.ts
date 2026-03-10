import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubProvider } from "./github.js";
import type { RunCommand } from "../context.js";

function ok(stdout: string) {
  return {
    code: 0,
    stdout,
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

describe("GitHubProvider repoRemote binding", () => {
  it("does not append --repo to global gh auth status health checks", async () => {
    const calls: Array<{ cmd: string[]; cwd?: string }> = [];
    const runCommand: RunCommand = async (cmd, opts) => {
      calls.push({ cmd, cwd: typeof opts === "object" ? opts?.cwd : undefined });
      return ok("");
    };

    const provider = new GitHubProvider({
      repoPath: "/fake/repo",
      repoRemote: "https://github.com/rayjolt/devclaw.git",
      runCommand,
    });

    const healthy = await provider.healthCheck();

    assert.equal(healthy, true);
    assert.deepEqual(calls, [{
      cmd: ["gh", "auth", "status"],
      cwd: "/fake/repo",
    }]);
  });

  it("binds gh issue commands to the configured repo when extra remotes exist", async () => {
    const calls: Array<{ cmd: string[]; cwd?: string }> = [];
    const runCommand: RunCommand = async (cmd, opts) => {
      calls.push({ cmd, cwd: typeof opts === "object" ? opts?.cwd : undefined });
      return ok(JSON.stringify({
        number: 67,
        title: "Test issue",
        body: "Body",
        labels: [{ name: "To Do" }],
        state: "OPEN",
        url: "https://github.com/rayjolt/devclaw/issues/67",
      }));
    };

    const provider = new GitHubProvider({
      repoPath: "/fake/repo",
      repoRemote: "https://github.com/rayjolt/devclaw.git",
      runCommand,
    });

    const issue = await provider.getIssue(67);

    assert.equal(issue.iid, 67);
    assert.deepEqual(calls, [{
      cmd: [
        "gh", "issue", "view", "67", "--json", "number,title,body,labels,state,url", "--repo", "rayjolt/devclaw",
      ],
      cwd: "/fake/repo",
    }]);
  });

  it("expands API repo placeholders from repoRemote instead of relying on cwd repo selection", async () => {
    const calls: Array<string[]> = [];
    const runCommand: RunCommand = async (cmd) => {
      calls.push(cmd);
      return ok('{"id":1,"author":"octocat","body":"hello","created_at":"2026-03-10T00:00:00Z"}');
    };

    const provider = new GitHubProvider({
      repoPath: "/fake/repo",
      repoRemote: "git@github.com:rayjolt/devclaw.git",
      runCommand,
    });

    const comments = await provider.listComments(67);

    assert.equal(comments.length, 1);
    assert.deepEqual(calls[0], [
      "gh",
      "api",
      "repos/rayjolt/devclaw/issues/67/comments",
      "--paginate",
      "--jq",
      ".[] | {id: .id, author: .user.login, body: .body, created_at: .created_at}",
    ]);
  });

  it("uses configured repoRemote for dependency GraphQL queries without gh repo view", async () => {
    const calls: Array<string[]> = [];
    const runCommand: RunCommand = async (cmd) => {
      calls.push(cmd);
      return ok(JSON.stringify({
        data: {
          repository: {
            issue: {
              blockedBy: { nodes: [] },
              blocking: { nodes: [] },
            },
          },
        },
      }));
    };

    const provider = new GitHubProvider({
      repoPath: "/fake/repo",
      repoRemote: "https://github.com/rayjolt/devclaw",
      runCommand,
    });

    const deps = await provider.getIssueDependencies(67);

    assert.deepEqual(deps, { issueId: 67, blockers: [], dependents: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "gh");
    assert.equal(calls[0]?.[1], "api");
    assert.equal(calls[0]?.[2], "graphql");
    assert.match(calls[0]?.[4] ?? "", /repository\(owner: "rayjolt", name: "devclaw"\)/);
  });
});
