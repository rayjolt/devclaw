/**
 * session.ts — Session management helpers for dispatch.
 */
import type { RunCommand } from "../context.js";
import { log as auditLog } from "../audit.js";
import { fetchGatewaySessions } from "../services/gateway-sessions.js";

// ---------------------------------------------------------------------------
// Context budget management
// ---------------------------------------------------------------------------

/**
 * Determine whether a session should be cleared based on context budget.
 *
 * Rules:
 * - If same issue (feedback cycle), keep session — worker needs prior context
 * - If context ratio exceeds sessionContextBudget, clear
 */
export async function shouldClearSession(
  sessionKey: string,
  slotIssueId: string | null,
  newIssueId: number,
  timeouts: import("../config/types.js").ResolvedTimeouts,
  workspaceDir: string,
  projectName: string,
  runCommand: RunCommand,
): Promise<boolean> {
  // Don't clear if re-dispatching for the same issue (feedback cycle)
  if (slotIssueId && String(newIssueId) === String(slotIssueId)) {
    return false;
  }

  // Check context budget via gateway session data
  try {
    const sessions = await fetchGatewaySessions(undefined, runCommand);
    if (!sessions) return false; // Gateway unavailable — don't clear

    const session = sessions.get(sessionKey);
    if (!session) return false; // Session not found — will be spawned fresh anyway

    const ratio = session.percentUsed / 100;
    if (ratio > timeouts.sessionContextBudget) {
      await auditLog(workspaceDir, "session_budget_reset", {
        project: projectName,
        sessionKey,
        reason: "context_budget",
        percentUsed: session.percentUsed,
        threshold: timeouts.sessionContextBudget * 100,
        totalTokens: session.totalTokens,
        contextTokens: session.contextTokens,
      });
      return true;
    }
  } catch {
    // Gateway query failed — don't clear, let dispatch proceed normally
  }

  return false;
}

// ---------------------------------------------------------------------------
// Private helpers — exist so dispatchTask reads as a sequence of steps
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget session creation/update.
 * Session key is deterministic, so we don't need to wait for confirmation.
 * If this fails, health check will catch orphaned state later.
 */
export function ensureSessionFireAndForget(
  sessionKey: string,
  model: string,
  workspaceDir: string,
  runCommand: RunCommand,
  timeoutMs = 30_000,
  label?: string,
): void {
  const rc = runCommand;
  const params: Record<string, unknown> = { key: sessionKey, model };
  if (label) params.label = label;
  rc(
    [
      "openclaw",
      "gateway",
      "call",
      "sessions.patch",
      "--params",
      JSON.stringify(params),
    ],
    { timeoutMs },
  ).catch((err) => {
    auditLog(workspaceDir, "dispatch_warning", {
      step: "ensureSession",
      sessionKey,
      error: (err as Error).message ?? String(err),
    }).catch(() => {});
  });
}

export type DispatchAcceptance = {
  accepted: boolean;
  status:
    | "accepted"
    | "started"
    | "deduped"
    | "rejected"
    | "unavailable"
    | "timeout"
    | "failed";
  runId?: string;
  reason?: string;
  raw?: unknown;
};

export async function sendToAgent(
  sessionKey: string,
  taskMessage: string,
  opts: {
    agentId?: string;
    projectName: string;
    issueId: number;
    role: string;
    level?: string;
    slotIndex?: number;
    dispatchAttempt?: number;
    orchestratorSessionKey?: string;
    workspaceDir: string;
    dispatchTimeoutMs?: number;
    extraSystemPrompt?: string;
    model?: string;
    runCommand: RunCommand;
  },
): Promise<DispatchAcceptance> {
  const rc = opts.runCommand;
  const gatewayParams = JSON.stringify({
    idempotencyKey: `devclaw-${opts.projectName}-${opts.issueId}-${opts.role}-${opts.level ?? "unknown"}-${opts.slotIndex ?? 0}-${opts.dispatchAttempt ?? 0}-${sessionKey}`,
    agentId: opts.agentId ?? "devclaw",
    sessionKey,
    message: taskMessage,
    deliver: false,
    lane: "subagent",
    ...(opts.orchestratorSessionKey
      ? { spawnedBy: opts.orchestratorSessionKey }
      : {}),
    ...(opts.extraSystemPrompt
      ? { extraSystemPrompt: opts.extraSystemPrompt }
      : {}),
    ...(opts.model ? { model: opts.model } : {}),
  });

  try {
    const result = await rc(
      [
        "openclaw",
        "gateway",
        "call",
        "agent",
        "--params",
        gatewayParams,
        "--expect-final",
        "--json",
      ],
      { timeoutMs: opts.dispatchTimeoutMs ?? 600_000 },
    );
    return parseDispatchAcceptance(result.stdout);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const timeout = /timeout|timed out/i.test(msg);
    const status: DispatchAcceptance["status"] = timeout ? "timeout" : "failed";
    await auditLog(opts.workspaceDir, "dispatch_warning", {
      step: "sendToAgent",
      sessionKey,
      issue: opts.issueId,
      role: opts.role,
      error: msg,
      status,
    });
    return { accepted: false, status, reason: msg };
  }
}

function parseDispatchAcceptance(stdout: string): DispatchAcceptance {
  let parsed: unknown;
  try {
    parsed = stdout ? JSON.parse(stdout) : undefined;
  } catch {
    return {
      accepted: false,
      status: "failed",
      reason: "agent RPC returned invalid JSON",
      raw: stdout,
    };
  }

  const o = (parsed ?? {}) as Record<string, unknown>;
  const status = normalizeStatus(
    o.status ??
      (o.result as Record<string, unknown> | undefined)?.status ??
      (o.final as Record<string, unknown> | undefined)?.status,
  );
  const runId =
    String(
      o.runId ??
        (o.result as Record<string, unknown> | undefined)?.runId ??
        (o.final as Record<string, unknown> | undefined)?.runId ??
        "",
    ) || undefined;

  if (status === "accepted" || status === "started") {
    return { accepted: true, status, runId, raw: parsed };
  }

  if (
    status === "deduped" ||
    status === "rejected" ||
    status === "unavailable" ||
    status === "timeout"
  ) {
    return {
      accepted: false,
      status,
      runId,
      reason: String(
        o.reason ??
          (o.result as Record<string, unknown> | undefined)?.reason ??
          "",
      ),
      raw: parsed,
    };
  }

  const acceptedFlag =
    o.accepted ?? (o.result as Record<string, unknown> | undefined)?.accepted;
  if (
    acceptedFlag === true ||
    (runId &&
      (o.ok === true ||
        (o.result as Record<string, unknown> | undefined)?.ok === true))
  ) {
    return { accepted: true, status: "accepted", runId, raw: parsed };
  }

  if (acceptedFlag === false) {
    return {
      accepted: false,
      status: "rejected",
      runId,
      reason: String(
        o.reason ??
          (o.result as Record<string, unknown> | undefined)?.reason ??
          "",
      ),
      raw: parsed,
    };
  }

  return {
    accepted: false,
    status: "failed",
    runId,
    reason: "agent RPC did not include acceptance status",
    raw: parsed,
  };
}

function normalizeStatus(
  value: unknown,
): DispatchAcceptance["status"] | undefined {
  const s = String(value ?? "").toLowerCase();
  if (!s) return undefined;
  if (s === "accepted" || s === "started") return s;
  if (s === "deduped" || s === "duplicate" || s === "idempotent_replay")
    return "deduped";
  if (s === "rejected" || s === "denied") return "rejected";
  if (s === "unavailable" || s === "offline") return "unavailable";
  if (s === "timeout" || s === "timed_out") return "timeout";
  return "failed";
}
