/**
 * Tests for provider dependency retrieval normalization.
 *
 * Run with: npx tsx --test lib/providers/provider-issue-dependencies.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import type { RunCommand } from "../context.js";
import { GitHubProvider } from "./github.js";
import { GitLabProvider } from "./gitlab.js";

function createGitHubRunCommand(opts: {
  trackedInIssues?: Array<{ number: number; title: string; state: string; url: string }>;
  trackedIssues?: Array<{ number: number; title: string; state: string; url: string }>;
  failGraphql?: boolean;
}): RunCommand {
  const trackedInIssues = opts.trackedInIssues ?? [];
  const trackedIssues = opts.trackedIssues ?? [];

  return (async (command: string[]) => {
    const rendered = command.join(" ");

    if (rendered.includes("gh repo view --json owner,name")) {
      return {
        stdout: JSON.stringify({ owner: { login: "rayjolt" }, name: "devclaw" }),
        stderr: "",
        exitCode: 0,
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      } as any;
    }

    if (rendered.includes("gh api graphql")) {
      if (opts.failGraphql) throw new Error("GraphQL is down");
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: {
                trackedInIssues: { nodes: trackedInIssues },
                trackedIssues: { nodes: trackedIssues },
              },
            },
          },
        }),
        stderr: "",
        exitCode: 0,
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      } as any;
    }

    throw new Error(`Unexpected command: ${rendered}`);
  }) as RunCommand;
}

describe("GitHubProvider.getIssueDependencies", () => {
  it("returns empty blockers/dependents when no dependencies exist", async () => {
    const provider = new GitHubProvider({
      repoPath: "/fake",
      runCommand: createGitHubRunCommand({}),
    });

    const deps = await provider.getIssueDependencies(42);

    assert.strictEqual(deps.issueId, 42);
    assert.deepStrictEqual(deps.blockers, []);
    assert.deepStrictEqual(deps.dependents, []);
  });

  it("normalizes a single blocker relation", async () => {
    const provider = new GitHubProvider({
      repoPath: "/fake",
      runCommand: createGitHubRunCommand({
        trackedInIssues: [
          { number: 1, title: "Parent", state: "OPEN", url: "https://github.com/o/r/issues/1" },
        ],
      }),
    });

    const deps = await provider.getIssueDependencies(2);

    assert.strictEqual(deps.blockers.length, 1);
    assert.strictEqual(deps.blockers[0].iid, 1);
    assert.strictEqual(deps.blockers[0].relation, "blocked_by");
    assert.deepStrictEqual(deps.dependents, []);
  });

  it("normalizes multiple blockers and dependents", async () => {
    const provider = new GitHubProvider({
      repoPath: "/fake",
      runCommand: createGitHubRunCommand({
        trackedInIssues: [
          { number: 1, title: "Blocker A", state: "OPEN", url: "https://github.com/o/r/issues/1" },
          { number: 3, title: "Blocker B", state: "OPEN", url: "https://github.com/o/r/issues/3" },
        ],
        trackedIssues: [
          { number: 7, title: "Dependent", state: "OPEN", url: "https://github.com/o/r/issues/7" },
        ],
      }),
    });

    const deps = await provider.getIssueDependencies(2);

    assert.strictEqual(deps.blockers.length, 2);
    assert.strictEqual(deps.blockers[1].iid, 3);
    assert.strictEqual(deps.dependents.length, 1);
    assert.strictEqual(deps.dependents[0].iid, 7);
    assert.strictEqual(deps.dependents[0].relation, "blocks");
  });

  it("surfaces provider errors for upstream retry/fail-closed behavior", async () => {
    const provider = new GitHubProvider({
      repoPath: "/fake",
      runCommand: createGitHubRunCommand({ failGraphql: true }),
    });

    await assert.rejects(() => provider.getIssueDependencies(2), /GraphQL is down/);
  });
});

describe("GitLabProvider.getIssueDependencies", () => {
  it("preserves backward compatibility with normalized empty graph", async () => {
    const runCommand: RunCommand = (async () => {
      throw new Error("should not be called");
    }) as RunCommand;

    const provider = new GitLabProvider({ repoPath: "/fake", runCommand });
    const deps = await provider.getIssueDependencies(123);

    assert.deepStrictEqual(deps, { issueId: 123, blockers: [], dependents: [] });
  });
});
