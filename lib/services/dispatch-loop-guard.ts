import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { log as auditLog } from "../audit.js";
import { DATA_DIR } from "../setup/migrate-layout.js";
import type { IssueProvider } from "../providers/provider.js";

const DEFAULT_MAX_DISPATCHES = 3;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DESYNC_LABEL = "workflow:desync";

export type DispatchLoopGuardResult =
  | { quarantined: false; recentDispatches: number }
  | {
      quarantined: true;
      recentDispatches: number;
      quarantineLabel: string;
      addedLabel: string;
    };

type AuditEntry = {
  ts?: string;
  event?: string;
  issue?: number;
  role?: string;
};

function parseAuditEntries(content: string): AuditEntry[] {
  return content
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as AuditEntry];
      } catch {
        return [];
      }
    });
}

function getEntryTime(entry: AuditEntry): number | null {
  if (!entry.ts) return null;
  const time = Date.parse(entry.ts);
  return Number.isNaN(time) ? null : time;
}

export async function countRecentDispatchesSinceLastQuarantine(opts: {
  workspaceDir: string;
  issueId: number;
  role: string;
  now?: number;
  windowMs?: number;
}): Promise<number> {
  const {
    workspaceDir,
    issueId,
    role,
    now = Date.now(),
    windowMs = DEFAULT_WINDOW_MS,
  } = opts;

  const auditPath = join(workspaceDir, DATA_DIR, "log", "audit.log");

  let content = "";
  try {
    content = await readFile(auditPath, "utf-8");
  } catch {
    return 0;
  }

  const cutoff = now - windowMs;
  const entries = parseAuditEntries(content).filter(
    (entry) => entry.issue === issueId && entry.role === role,
  );

  let lastQuarantineTs = -Infinity;
  for (const entry of entries) {
    if (entry.event !== "dispatch_loop_quarantined") continue;
    const time = getEntryTime(entry);
    if (time !== null && time >= cutoff && time > lastQuarantineTs) {
      lastQuarantineTs = time;
    }
  }

  let dispatchCount = 0;
  for (const entry of entries) {
    if (entry.event !== "dispatch") continue;
    const time = getEntryTime(entry);
    if (time === null || time < cutoff || time <= lastQuarantineTs) continue;
    dispatchCount += 1;
  }

  return dispatchCount;
}

export async function guardDispatchLoop(opts: {
  workspaceDir: string;
  provider: IssueProvider;
  projectName: string;
  issueId: number;
  issueTitle: string;
  role: string;
  fromLabel: string;
  quarantineLabel: string;
  maxDispatches?: number;
  windowMs?: number;
  now?: number;
}): Promise<DispatchLoopGuardResult> {
  const {
    workspaceDir,
    provider,
    projectName,
    issueId,
    issueTitle,
    role,
    fromLabel,
    quarantineLabel,
    maxDispatches = DEFAULT_MAX_DISPATCHES,
    windowMs = DEFAULT_WINDOW_MS,
    now,
  } = opts;

  const recentDispatches = await countRecentDispatchesSinceLastQuarantine({
    workspaceDir,
    issueId,
    role,
    now,
    windowMs,
  });

  if (recentDispatches < maxDispatches) {
    return { quarantined: false, recentDispatches };
  }

  await provider.transitionLabel(issueId, fromLabel, quarantineLabel);
  await provider.addLabel(issueId, DESYNC_LABEL);
  await provider.addComment(
    issueId,
    [
      `⚠️ Dispatch loop detected for **${role}** on issue #${issueId}.`,
      "",
      `This issue was dispatched ${recentDispatches} times within the last ${Math.round(windowMs / 60000)} minutes without a successful reconciliation, so DevClaw moved it to **${quarantineLabel}** and paused further dispatches.`,
      "",
      "Suggested recovery steps:",
      "1. Reconcile the actual issue state/labels with worker slot state.",
      "2. Clear any stale owner or role:level labels if they no longer match reality.",
      `3. Requeue manually once consistent (for example, move back out of **${quarantineLabel}** and run \`task_start\`).`,
    ].join("\n"),
  );

  await auditLog(workspaceDir, "dispatch_loop_quarantined", {
    project: projectName,
    issue: issueId,
    issueTitle,
    role,
    recentDispatches,
    fromLabel,
    toLabel: quarantineLabel,
    label: DESYNC_LABEL,
  });

  return {
    quarantined: true,
    recentDispatches,
    quarantineLabel,
    addedLabel: DESYNC_LABEL,
  };
}
