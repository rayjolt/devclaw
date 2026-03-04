/**
 * session.ts — Session management helpers for dispatch.
 */
import type { RunCommand } from "../context.js";
import { log as auditLog } from "../audit.js";
import { fetchGatewaySessions } from "../services/gateway-sessions.js";

const REQUEST_TEXT_TRUNCATE_AT = 2_000;
const RESPONSE_TEXT_TRUNCATE_AT = 4_000;
const RESPONSE_ARRAY_TRUNCATE_AT = 20;
const NON_TRUNCATED_DIAGNOSTIC_FIELDS = new Set([
  "idempotencyKey",
  "agentId",
  "sessionKey",
  "lane",
  "status",
  "runId",
  "reason",
  "mode",
]);

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
  /** How acceptance was inferred (early ack vs final response compatibility path). */
  mode?:
    | "early-status"
    | "final-ok"
    | "accepted-flag"
    | "legacy-ok"
    | "explicit-failure"
    | "invalid";
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
  const gatewayParamsObj = {
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
  };
  const gatewayParams = JSON.stringify(gatewayParamsObj);
  await auditLog(opts.workspaceDir, "dispatch_debug", {
    step: "sendToAgent.request",
    issue: opts.issueId,
    role: opts.role,
    envelope: sanitizeRequestEnvelopeForLog(gatewayParamsObj),
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
    const parsedStdout = tryParseJson(result.stdout);
    const acceptance = parseDispatchAcceptance(result.stdout);
    await auditLog(opts.workspaceDir, "dispatch_debug", {
      step: "sendToAgent.response",
      issue: opts.issueId,
      role: opts.role,
      envelope: sanitizeResponseEnvelopeForLog(parsedStdout ?? result.stdout),
      status: acceptance.status,
      runId: acceptance.runId,
      reason: acceptance.reason,
      mode: acceptance.mode,
    });
    return acceptance;
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
      mode: "invalid",
      raw: stdout,
    };
  }

  const o = (parsed ?? {}) as Record<string, unknown>;
  const result = (o.result as Record<string, unknown> | undefined) ?? undefined;
  const final = (o.final as Record<string, unknown> | undefined) ?? undefined;

  const topStatus = normalizeStatus(o.status);
  const nestedStatus = normalizeStatus(result?.status ?? final?.status);
  const topStatusRaw = String(o.status ?? "").toLowerCase();
  const runId =
    String(o.runId ?? result?.runId ?? final?.runId ?? "") || undefined;
  const reason = String(o.reason ?? result?.reason ?? final?.reason ?? "");

  // Respect explicit nested final statuses first. With --expect-final,
  // top-level status is often transport-level (e.g. "ok") and must not mask
  // result.status like "rejected"/"deduped".
  if (nestedStatus === "accepted" || nestedStatus === "started") {
    return {
      accepted: true,
      status: nestedStatus,
      runId,
      mode: "early-status",
      raw: parsed,
    };
  }

  if (
    nestedStatus === "deduped" ||
    nestedStatus === "rejected" ||
    nestedStatus === "unavailable" ||
    nestedStatus === "timeout"
  ) {
    return {
      accepted: false,
      status: nestedStatus,
      runId,
      reason,
      mode: "explicit-failure",
      raw: parsed,
    };
  }

  if (topStatus === "accepted" || topStatus === "started") {
    return {
      accepted: true,
      status: topStatus,
      runId,
      mode: "early-status",
      raw: parsed,
    };
  }

  if (
    topStatus === "deduped" ||
    topStatus === "rejected" ||
    topStatus === "unavailable" ||
    topStatus === "timeout"
  ) {
    return {
      accepted: false,
      status: topStatus,
      runId,
      reason,
      mode: "explicit-failure",
      raw: parsed,
    };
  }

  const acceptedFlag = o.accepted ?? result?.accepted;
  if (acceptedFlag === false) {
    return {
      accepted: false,
      status: "rejected",
      runId,
      reason,
      mode: "accepted-flag",
      raw: parsed,
    };
  }

  if (acceptedFlag === true) {
    return {
      accepted: true,
      status: "accepted",
      runId,
      mode: "accepted-flag",
      raw: parsed,
    };
  }

  // --expect-final compatibility:
  // gateway call can return final lifecycle envelopes like:
  // { status: "ok", runId: "..." }
  // { status: "ok", runId: "...", result: { ... } }
  // Treat as accepted when transport-level status is ok and runId exists.
  // Explicit nested failures are handled above, so they cannot be masked here.
  if (topStatusRaw === "ok" && runId) {
    return {
      accepted: true,
      status: "accepted",
      runId,
      mode: "final-ok",
      raw: parsed,
    };
  }

  if (runId && (o.ok === true || result?.ok === true)) {
    return {
      accepted: true,
      status: "accepted",
      runId,
      mode: "legacy-ok",
      raw: parsed,
    };
  }

  return {
    accepted: false,
    status: "failed",
    runId,
    reason: "agent RPC did not include acceptance status",
    mode: "invalid",
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

function sanitizeRequestEnvelopeForLog(
  envelope: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope)) {
    if (
      (key === "message" || key === "extraSystemPrompt") &&
      typeof value === "string"
    ) {
      out[key] = truncateStringWithMarker(value, REQUEST_TEXT_TRUNCATE_AT);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function sanitizeResponseEnvelopeForLog(envelope: unknown): unknown {
  return sanitizeResponseValueForLog(envelope);
}

function sanitizeResponseValueForLog(
  value: unknown,
  keyHint?: string,
): unknown {
  if (
    keyHint &&
    NON_TRUNCATED_DIAGNOSTIC_FIELDS.has(keyHint) &&
    (typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value == null)
  ) {
    return value;
  }

  if (typeof value === "string") {
    return truncateStringWithMarker(value, RESPONSE_TEXT_TRUNCATE_AT);
  }

  if (Array.isArray(value)) {
    if (value.length <= RESPONSE_ARRAY_TRUNCATE_AT) {
      return value.map((item) => sanitizeResponseValueForLog(item));
    }
    const kept = value
      .slice(0, RESPONSE_ARRAY_TRUNCATE_AT)
      .map((item) => sanitizeResponseValueForLog(item));
    kept.push({
      __truncated: true,
      kind: "array",
      originalLength: value.length,
      keptLength: RESPONSE_ARRAY_TRUNCATE_AT,
    });
    return kept;
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeResponseValueForLog(v, k);
    }
    return out;
  }

  return value;
}

function truncateStringWithMarker(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...[truncated originalLength=${value.length} keptLength=${maxLength}]`;
}

function tryParseJson(input: string): unknown | undefined {
  if (!input) return undefined;
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}
