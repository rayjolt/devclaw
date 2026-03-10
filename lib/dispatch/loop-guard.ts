import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IssueProvider } from "../providers/provider.js";
import type { WorkflowConfig } from "../workflow/index.js";
import { StateType } from "../workflow/index.js";
import { DATA_DIR } from "../setup/migrate-layout.js";
import { log as auditLog } from "../audit.js";

const DEFAULT_WINDOW_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_DISPATCHES = 3;
const DESYNC_LABEL = "workflow:desync";

function quarantineMarker(issueId: number): string {
  return `<!-- devclaw:dispatch-loop:${issueId} -->`;
}

function findHoldLabel(workflow: WorkflowConfig): string | null {
  const refining = Object.values(workflow.states).find(
    (state) => state.type === StateType.HOLD && state.label === "Refining",
  );
  if (refining) return refining.label;
  return (
    Object.values(workflow.states).find(
      (state) => state.type === StateType.HOLD,
    )?.label ?? null
  );
}

type AuditEntry = {
  event?: string;
  ts?: string;
  issue?: number;
  role?: string;
  project?: string;
  labelTransition?: string;
};

async function countRecentDispatches(
  workspaceDir: string,
  projectName: string,
  issueId: number,
  role: string,
  windowMs: number,
): Promise<number> {
  const auditPath = join(workspaceDir, DATA_DIR, "log", "audit.log");
  try {
    const content = await readFile(auditPath, "utf-8");
    const cutoff = Date.now() - windowMs;
    const entries = content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is AuditEntry => !!entry)
      .filter((entry) => {
        const ts = entry.ts ? Date.parse(entry.ts) : NaN;
        return Number.isFinite(ts) && ts >= cutoff;
      })
      .filter(
        (entry) =>
          entry.project === projectName &&
          entry.issue === issueId &&
          entry.role === role,
      );

    const lastQuarantineTs = entries
      .filter((entry) => entry.event === "dispatch_loop_quarantined")
      .reduce<number>((latest, entry) => {
        const ts = entry.ts ? Date.parse(entry.ts) : NaN;
        return Number.isFinite(ts) ? Math.max(latest, ts) : latest;
      }, Number.NEGATIVE_INFINITY);

    return entries
      .filter((entry) => entry.event === "dispatch")
      .filter((entry) => {
        if (!Number.isFinite(lastQuarantineTs)) return true;
        const ts = entry.ts ? Date.parse(entry.ts) : NaN;
        return Number.isFinite(ts) && ts > lastQuarantineTs;
      }).length;
  } catch {
    return 0;
  }
}

async function ensureQuarantineComment(
  provider: IssueProvider,
  issueId: number,
  body: string,
): Promise<boolean> {
  const marker = quarantineMarker(issueId);
  const comments = await provider.listComments(issueId).catch(() => []);
  if (comments.some((comment) => comment.body.includes(marker))) {
    return false;
  }
  await provider.addComment(issueId, `${body}\n\n${marker}`);
  return true;
}

export async function guardDispatchLoop(opts: {
  workspaceDir: string;
  provider: IssueProvider;
  workflow: WorkflowConfig;
  issueId: number;
  issueTitle: string;
  issueUrl: string;
  role: string;
  fromLabel: string;
  toLabel: string;
  projectName: string;
  windowMs?: number;
  maxDispatches?: number;
}): Promise<
  | { quarantined: false }
  | { quarantined: true; holdLabel: string; dispatches: number }
> {
  const {
    workspaceDir,
    provider,
    workflow,
    issueId,
    issueTitle,
    issueUrl,
    role,
    fromLabel,
    toLabel,
    projectName,
    windowMs = DEFAULT_WINDOW_MS,
    maxDispatches = DEFAULT_MAX_DISPATCHES,
  } = opts;

  const recentDispatches = await countRecentDispatches(
    workspaceDir,
    projectName,
    issueId,
    role,
    windowMs,
  );

  if (recentDispatches < maxDispatches) {
    return { quarantined: false };
  }

  const holdLabel = findHoldLabel(workflow);
  if (!holdLabel) {
    await auditLog(workspaceDir, "dispatch_loop_detected", {
      project: projectName,
      issue: issueId,
      issueTitle,
      role,
      fromLabel,
      toLabel,
      dispatches: recentDispatches,
      windowMs,
      quarantined: false,
      reason: "no_hold_state",
    }).catch(() => {});
    return { quarantined: false };
  }

  const issue = await provider.getIssue(issueId).catch(() => null);
  const currentLabel = issue
    ? issue.labels.find(
        (label) =>
          label === fromLabel || label === toLabel || label === holdLabel,
      )
    : null;
  const transitionFrom = currentLabel ?? fromLabel;

  if (transitionFrom !== holdLabel) {
    await provider
      .transitionLabel(issueId, transitionFrom, holdLabel)
      .catch(async (err) => {
        await auditLog(workspaceDir, "dispatch_loop_detected", {
          project: projectName,
          issue: issueId,
          issueTitle,
          role,
          fromLabel: transitionFrom,
          toLabel: holdLabel,
          dispatches: recentDispatches,
          windowMs,
          quarantined: false,
          reason: "transition_failed",
          error: (err as Error).message ?? String(err),
        }).catch(() => {});
        throw err;
      });
  }

  await provider.ensureLabel(DESYNC_LABEL, "B60205").catch(() => {});
  await provider.addLabel(issueId, DESYNC_LABEL).catch(() => {});

  const commentPosted = await ensureQuarantineComment(
    provider,
    issueId,
    `⚠️ DevClaw paused this issue after detecting a dispatch loop.\n\n` +
      `- Project: ${projectName}\n` +
      `- Issue: #${issueId} — ${issueTitle}\n` +
      `- Role: ${role}\n` +
      `- Recent dispatches: ${recentDispatches} within ${Math.round(windowMs / 60_000)} minutes\n` +
      `- Attempted transition: ${fromLabel} → ${toLabel}\n` +
      `- Quarantined state: ${holdLabel}\n\n` +
      `Suggested corrective actions:\n` +
      `1. Inspect the most recent worker comment and audit trail for rejected work_finish calls.\n` +
      `2. Reconcile labels / worker state (clear stale owner or role labels if needed).\n` +
      `3. Requeue manually once state is consistent.\n\n` +
      `Reference: ${issueUrl}`,
  ).catch(() => false);

  await auditLog(workspaceDir, "dispatch_loop_quarantined", {
    project: projectName,
    issue: issueId,
    issueTitle,
    role,
    fromLabel: transitionFrom,
    attemptedTo: toLabel,
    quarantineLabel: holdLabel,
    dispatches: recentDispatches,
    windowMs,
    commentPosted,
  }).catch(() => {});

  return { quarantined: true, holdLabel, dispatches: recentDispatches };
}

export const LOOP_GUARD_CONSTANTS = {
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_DISPATCHES,
  DESYNC_LABEL,
};
