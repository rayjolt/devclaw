/**
 * queue-scan.ts — Issue queue scanning helpers.
 *
 * Shared by: tick (projectTick), work-start (auto-pickup), and other consumers
 * that need to find queued issues or detect roles/levels from labels.
 */
import type {
  Issue,
  IssueDependency,
  IssueDependencies,
  StateLabel,
} from "../providers/provider.js";
import type { IssueProvider } from "../providers/provider.js";
import { getLevelsForRole, getAllLevels } from "../roles/index.js";
import {
  getQueueLabels,
  getAllQueueLabels,
  detectRoleFromLabel as workflowDetectRole,
  findStateByLabel,
  isOwnedByOrUnclaimed,
  type WorkflowConfig,
  type Role,
} from "../workflow/index.js";

// ---------------------------------------------------------------------------
// Label detection
// ---------------------------------------------------------------------------

export function detectLevelFromLabels(labels: string[]): string | null {
  const lower = labels.map((l) => l.toLowerCase());

  // Priority 1: Match role:level labels (e.g., "developer:senior", "developer:senior:Ada")
  for (const l of lower) {
    const parts = l.split(":");
    if (parts.length < 2) continue;
    const level = parts[1]!;
    const all = getAllLevels();
    if (all.includes(level)) return level;
  }

  // Priority 2: Match legacy role.level labels (e.g., "dev.senior", "qa.mid")
  for (const l of lower) {
    const dot = l.indexOf(".");
    if (dot === -1) continue;
    const role = l.slice(0, dot);
    const level = l.slice(dot + 1);
    const roleLevels = getLevelsForRole(role);
    if (roleLevels.includes(level)) return level;
  }

  // Fallback: plain level name
  const all = getAllLevels();
  return all.find((l) => lower.includes(l)) ?? null;
}

/**
 * Detect role, level, and optional slot name from colon-format labels.
 * Supports both 2-segment ("developer:senior") and 3-segment ("developer:senior:Ada") formats.
 * Returns the first match found, or null if no role:level label exists.
 */
export function detectRoleLevelFromLabels(
  labels: string[],
): { role: string; level: string; name?: string } | null {
  for (const label of labels) {
    const parts = label.split(":");
    if (parts.length < 2) continue;
    const role = parts[0]!.toLowerCase();
    const level = parts[1]!.toLowerCase();
    const roleLevels = getLevelsForRole(role);
    if (roleLevels.includes(level)) {
      return { role, level, name: parts[2] };
    }
  }
  return null;
}

/**
 * Detect step routing from labels (e.g. "review:human", "test:skip").
 * Returns the routing value for the given step, or null if no routing label exists.
 */
export function detectStepRouting(
  labels: string[],
  step: string,
): string | null {
  const prefix = `${step}:`;
  const match = labels.find((l) => l.toLowerCase().startsWith(prefix));
  return match ? match.slice(prefix.length).toLowerCase() : null;
}

/**
 * Detect role from a label using workflow config.
 */
export function detectRoleFromLabel(
  label: StateLabel,
  workflow: WorkflowConfig,
): Role | null {
  return workflowDetectRole(workflow, label);
}

export type DependencyGateStatus = {
  blocked: boolean;
  reason?: string;
  cyclePath?: number[];
  kind?: "dependency" | "cycle" | "uncertain";
};

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

// ---------------------------------------------------------------------------
// Issue queue queries
// ---------------------------------------------------------------------------

export async function findNextIssueForRole(
  provider: Pick<IssueProvider, "listIssuesByLabel" | "getIssueDependencies"> &
    Partial<Pick<IssueProvider, "transitionLabel" | "addComment">>,
  role: Role,
  workflow: WorkflowConfig,
  instanceName?: string,
  opts?: {
    /**
     * Called when a dependency cycle is detected and the caller wants to take
     * action (e.g. move issue to Refining).
     */
    onCycleDetected?: (args: {
      issue: Issue;
      label: StateLabel;
      cyclePath: number[];
      reason: string;
    }) => Promise<void>;

    /**
     * Optional eligibility predicate for role-specific gates beyond dependency
     * checks (e.g. review:human, test:skip).
     *
     * If it returns false, the scan continues to the next issue.
     */
    isEligible?: (args: {
      issue: Issue;
      label: StateLabel;
    }) =>
      | boolean
      | Promise<boolean>
      | { ok: boolean; reason?: string }
      | Promise<{ ok: boolean; reason?: string }>;

    /** Called when an issue is skipped due to isEligible returning false. */
    onIneligible?: (args: {
      issue: Issue;
      label: StateLabel;
      reason?: string;
    }) => Promise<void>;
  },
): Promise<{ issue: Issue; label: StateLabel } | null> {
  const labels = getQueueLabels(workflow, role);
  for (const label of labels) {
    try {
      const issues = await provider.listIssuesByLabel(label);
      const eligible = instanceName
        ? issues.filter((i) => isOwnedByOrUnclaimed(i.labels, instanceName))
        : issues;

      // Providers typically return queue issues newest-first; scan oldest-first
      // to preserve FIFO semantics within each label queue.
      const queueOrder = eligible.slice().reverse();
      for (const issue of queueOrder) {
        const gate = await getDependencyGateStatus(provider, issue, workflow);
        if (gate.blocked) {
          if (
            gate.kind === "cycle" &&
            gate.cyclePath &&
            opts?.onCycleDetected
          ) {
            await opts.onCycleDetected({
              issue,
              label,
              cyclePath: gate.cyclePath,
              reason:
                gate.reason ??
                `Dependency cycle detected: ${gate.cyclePath.join(" → ")}`,
            });
          }
          continue;
        }

        if (opts?.isEligible) {
          try {
            const res = await opts.isEligible({ issue, label });
            const ok = typeof res === "boolean" ? res : res.ok;
            const reason = typeof res === "boolean" ? undefined : res.reason;
            if (!ok) {
              if (opts.onIneligible) {
                try {
                  await opts.onIneligible({ issue, label, reason });
                } catch (err) {
                  console.warn(
                    `[queue-scan] onIneligible failed for #${issue.iid} (${label}): ${toErrorMessage(err)}`,
                  );
                }
              }
              continue;
            }
          } catch (err) {
            console.warn(
              `[queue-scan] isEligible failed for #${issue.iid} (${label}): ${toErrorMessage(err)}`,
            );
            continue;
          }
        }

        return { issue, label };
      }
    } catch {
      /* continue */
    }
  }
  return null;
}

export async function getDependencyGateStatus(
  provider: Pick<IssueProvider, "getIssueDependencies">,
  issue: Pick<Issue, "iid">,
  workflow: WorkflowConfig,
): Promise<DependencyGateStatus> {
  const depCache = new Map<number, IssueDependencies | null>();
  const deps = await getIssueDependenciesWithRetry(provider, issue.iid, 3);
  if (!deps) {
    return {
      blocked: true,
      kind: "uncertain",
      reason: "Dependency status unavailable (provider read failed)",
    };
  }
  depCache.set(issue.iid, deps);

  const unresolved = deps.blockers.filter(
    (blocker) => !isResolvedBlocker(blocker, workflow),
  );
  if (unresolved.length === 0) return { blocked: false };

  const cyclePath = await detectCyclePath(
    provider,
    issue.iid,
    workflow,
    depCache,
  );
  if (cyclePath) {
    return {
      blocked: true,
      kind: "cycle",
      cyclePath,
      reason: `Dependency cycle detected: ${cyclePath.join(" → ")}`,
    };
  }

  const blockerIds = unresolved.map((b) => `#${b.iid}`).join(", ");
  return {
    blocked: true,
    kind: "dependency",
    reason: `Waiting on blockers: ${blockerIds}`,
  };
}

function isResolvedBlocker(
  blocker: IssueDependency,
  workflow: WorkflowConfig,
): boolean {
  const labels = blocker.labels ?? [];

  // Explicit requirement: Rejected blockers remain blocking.
  if (labels.some((l) => l.toLowerCase() === "rejected")) return false;

  // Any other terminal state label resolves the blocker.
  const hasTerminalLabel = labels.some((l) => {
    const state = findStateByLabel(workflow, l);
    return state?.type === "terminal";
  });
  if (hasTerminalLabel) return true;

  // Fallback when labels are unavailable: use provider issue state.
  const state = blocker.state.toLowerCase();
  return state === "closed" || state === "done" || state === "merged";
}

async function detectCyclePath(
  provider: Pick<IssueProvider, "getIssueDependencies">,
  startIssueId: number,
  workflow: WorkflowConfig,
  cache: Map<number, IssueDependencies | null>,
): Promise<number[] | null> {
  const visited = new Set<number>([startIssueId]);

  const dfs = async (
    nodeId: number,
    path: number[],
  ): Promise<number[] | null> => {
    let deps = cache.get(nodeId);
    if (deps === undefined) {
      deps = await getIssueDependenciesWithRetry(provider, nodeId, 3);
      cache.set(nodeId, deps ?? null);
    }
    if (!deps) return null;

    for (const blocker of deps.blockers.filter(
      (b) => !isResolvedBlocker(b, workflow),
    )) {
      if (blocker.iid === startIssueId) return [...path, startIssueId];
      if (visited.has(blocker.iid)) continue;
      visited.add(blocker.iid);
      const found = await dfs(blocker.iid, [...path, blocker.iid]);
      if (found) return found;
    }
    return null;
  };

  return dfs(startIssueId, [startIssueId]);
}

async function getIssueDependenciesWithRetry(
  provider: Pick<IssueProvider, "getIssueDependencies">,
  issueId: number,
  attempts: number,
): Promise<Awaited<ReturnType<IssueProvider["getIssueDependencies"]>> | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await provider.getIssueDependencies(issueId);
    } catch {
      if (i === attempts - 1) return null;
      await new Promise((resolve) => setTimeout(resolve, 150 * (i + 1)));
    }
  }
  return null;
}

/**
 * Find next issue for any role (optional filter).
 */
export async function findNextIssue(
  provider: Pick<IssueProvider, "listIssuesByLabel">,
  role: Role | undefined,
  workflow: WorkflowConfig,
  instanceName?: string,
): Promise<{ issue: Issue; label: StateLabel } | null> {
  const labels = role
    ? getQueueLabels(workflow, role)
    : getAllQueueLabels(workflow);

  for (const label of labels) {
    try {
      const issues = await provider.listIssuesByLabel(label);
      const eligible = instanceName
        ? issues.filter((i) => isOwnedByOrUnclaimed(i.labels, instanceName))
        : issues;
      if (eligible.length > 0)
        return { issue: eligible[eligible.length - 1]!, label };
    } catch {
      /* continue */
    }
  }
  return null;
}
