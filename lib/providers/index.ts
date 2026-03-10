/**
 * Provider factory — auto-detects GitHub vs GitLab from git remote.
 */
import type { IssueProvider } from "./provider.js";
import type { RunCommand } from "../context.js";
import { GitLabProvider } from "./gitlab.js";
import { GitHubProvider } from "./github.js";
import { resolveRepoPath } from "../projects/index.js";

export type ProviderOptions = {
  provider?: "gitlab" | "github";
  repo?: string;
  repoPath?: string;
  repoRemote?: string;
  runCommand: RunCommand;
};

export type ProviderWithType = {
  provider: IssueProvider;
  type: "github" | "gitlab";
};

async function detectProvider(
  repoPath: string,
  runCommand: RunCommand,
  repoRemote?: string,
): Promise<"gitlab" | "github"> {
  const remote = repoRemote?.trim();
  if (remote) return remote.includes("github.com") ? "github" : "gitlab";

  try {
    const result = await runCommand(["git", "remote", "get-url", "origin"], { timeoutMs: 5_000, cwd: repoPath });
    return result.stdout.trim().includes("github.com") ? "github" : "gitlab";
  } catch {
    return "gitlab";
  }
}

export async function createProvider(opts: ProviderOptions): Promise<ProviderWithType> {
  const repoPath = opts.repoPath ?? (opts.repo ? resolveRepoPath(opts.repo) : null);
  if (!repoPath) throw new Error("Either repoPath or repo must be provided");
  const rc = opts.runCommand;
  const type = opts.provider ?? await detectProvider(repoPath, rc, opts.repoRemote);
  const provider = type === "github"
    ? new GitHubProvider({ repoPath, repoRemote: opts.repoRemote, runCommand: rc })
    : new GitLabProvider({ repoPath, runCommand: rc });
  return { provider, type };
}
