import fs from "node:fs/promises";
import path from "node:path";
import type { IssueProvider } from "../../providers/provider.js";
import { DATA_DIR } from "../../setup/migrate-layout.js";

const DEFAULT_ATTEMPTS = 10;

type IssueCounter = {
  consecutiveNoChecks: number;
};

type CircuitBreakerState = {
  issues: Record<string, IssueCounter>;
};

const EMPTY_STATE: CircuitBreakerState = { issues: {} };

function filePath(workspaceDir: string, projectName: string): string {
  return path.join(
    workspaceDir,
    DATA_DIR,
    "runtime",
    "ci-no-checks",
    `${projectName}.json`,
  );
}

async function readState(
  workspaceDir: string,
  projectName: string,
): Promise<CircuitBreakerState> {
  const p = filePath(workspaceDir, projectName);
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as CircuitBreakerState;
    if (!parsed || typeof parsed !== "object") return EMPTY_STATE;
    return { issues: parsed.issues ?? {} };
  } catch {
    return EMPTY_STATE;
  }
}

async function writeState(
  workspaceDir: string,
  projectName: string,
  state: CircuitBreakerState,
): Promise<void> {
  const p = filePath(workspaceDir, projectName);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function getNoChecksBreakerAttempts(workflowAttempts?: number): number {
  if (Number.isInteger(workflowAttempts) && (workflowAttempts as number) > 0) {
    return workflowAttempts as number;
  }
  return DEFAULT_ATTEMPTS;
}

export function isNoChecksUnknown(ciSummary?: string): boolean {
  return (
    (ciSummary ?? "").trim().toLowerCase() === "no ci checks reported for pr"
  );
}

export async function incrementNoChecksCounter(opts: {
  workspaceDir: string;
  projectName: string;
  issueId: number;
}): Promise<number> {
  const state = await readState(opts.workspaceDir, opts.projectName);
  const key = String(opts.issueId);
  const current = state.issues[key]?.consecutiveNoChecks ?? 0;
  state.issues[key] = { consecutiveNoChecks: current + 1 };
  await writeState(opts.workspaceDir, opts.projectName, state);
  return state.issues[key]!.consecutiveNoChecks;
}

export async function resetNoChecksCounter(opts: {
  workspaceDir: string;
  projectName: string;
  issueId: number;
}): Promise<boolean> {
  const state = await readState(opts.workspaceDir, opts.projectName);
  const key = String(opts.issueId);
  if (!state.issues[key]) return false;
  delete state.issues[key];
  await writeState(opts.workspaceDir, opts.projectName, state);
  return true;
}

function breakerMarker(issueId: number, threshold: number): string {
  return `<!-- devclaw:ci-no-checks-breaker:${issueId}:${threshold} -->`;
}

function underThresholdMarker(issueId: number): string {
  return `<!-- devclaw:ci-no-checks-under-threshold:${issueId} -->`;
}

export async function postNoChecksUnderThresholdCommentOnce(opts: {
  provider: IssueProvider;
  issueId: number;
  threshold: number;
}): Promise<boolean> {
  const { provider, issueId, threshold } = opts;
  const marker = underThresholdMarker(issueId);
  const message = `⚠️ CI gate blocked auto-merge: No CI checks reported for PR. DevClaw will pause this loop after ${threshold} consecutive attempts.`;
  const comments = await provider.listComments(issueId);
  if (
    comments.some((c) => c.body.includes(marker) || c.body.trim() === message)
  ) {
    return false;
  }
  await provider.addComment(issueId, `${message}\n\n${marker}`);
  return true;
}

export async function postNoChecksBreakerCommentOnce(opts: {
  provider: IssueProvider;
  issueId: number;
  attempts: number;
}): Promise<boolean> {
  const { provider, issueId, attempts } = opts;
  const marker = breakerMarker(issueId, attempts);
  const message =
    `⏸️ DevClaw paused this issue after ${attempts} consecutive CI attempts with no checks reported. ` +
    `This prevents infinite To Improve/Review loops and token/quota burn.\n\n` +
    `Operator action: verify GitHub Actions availability/quota/repository settings, then re-queue the issue.`;
  const comments = await provider.listComments(issueId);
  if (
    comments.some((c) => c.body.includes(marker) || c.body.trim() === message)
  ) {
    return false;
  }
  await provider.addComment(issueId, `${message}\n\n${marker}`);
  return true;
}
