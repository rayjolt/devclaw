/**
 * dispatch/index.ts — Core dispatch logic used by projectTick (heartbeat).
 *
 * Handles: session lookup, spawn/reuse via Gateway RPC, task dispatch via CLI,
 * state update (activateWorker), and audit logging.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../context.js";
import { log as auditLog } from "../audit.js";
import {
  type Project,
  activateWorker,
  updateSlot,
  getRoleWorker,
  emptySlot,
} from "../projects/index.js";
import { resolveModel } from "../roles/index.js";
import { notify, getNotificationConfig } from "./notify.js";
import { loadConfig, type ResolvedRoleConfig } from "../config/index.js";
import {
  ReviewPolicy,
  TestPolicy,
  resolveReviewRouting,
  resolveTestRouting,
  resolveNotifyChannel,
  isFeedbackState,
  hasReviewCheck,
  producesReviewableWork,
  hasTestPhase,
  detectOwner,
  getOwnerLabel,
  OWNER_LABEL_COLOR,
  getRoleLabelColor,
  STEP_ROUTING_COLOR,
} from "../workflow/index.js";
import {
  fetchPrFeedback,
  fetchPrContext,
  type PrFeedback,
  type PrContext,
} from "./pr-context.js";
import { formatAttachmentsForTask } from "./attachments.js";
import { loadRoleInstructions } from "./bootstrap-hook.js";
import { slotName } from "../names.js";

import {
  buildTaskMessage,
  buildAnnouncement,
  formatSessionLabel,
} from "./message-builder.js";
import {
  ensureSessionFireAndForget,
  sendToAgent,
  shouldClearSession,
  type DispatchAcceptance,
} from "./session.js";
import { acknowledgeComments, EYES_EMOJI } from "./acknowledge.js";

export type DispatchOpts = {
  workspaceDir: string;
  agentId?: string;
  project: Project;
  issueId: number;
  issueTitle: string;
  issueDescription: string;
  issueUrl: string;
  role: string;
  /** Developer level (junior, mid, senior) or raw model ID */
  level: string;
  /** Label to transition FROM (e.g. "To Do", "To Test", "To Improve") */
  fromLabel: string;
  /** Label to transition TO (e.g. "Doing", "Testing") */
  toLabel: string;
  /** Issue provider for issue operations and label transitions */
  provider: import("../providers/provider.js").IssueProvider;
  /** Plugin config for model resolution and notification config */
  pluginConfig?: Record<string, unknown>;
  /** Orchestrator's session key (used as spawnedBy for subagent tracking) */
  sessionKey?: string;
  /** Plugin runtime for direct API access (avoids CLI subprocess timeouts) */
  runtime?: PluginRuntime;
  /** Slot index within the role's worker slots (defaults to 0 for single-worker compat) */
  slotIndex?: number;
  /** Instance name for ownership labels (auto-claimed on dispatch if not already owned) */
  instanceName?: string;
  /** Injected runCommand for dependency injection. */
  runCommand: RunCommand;
};

export type DispatchResult = {
  sessionAction: "spawn" | "send";
  sessionKey: string;
  level: string;
  model: string;
  announcement: string;
};

/**
 * Dispatch a task to a worker session.
 *
 * Flow:
 *   1. Resolve model, session key, build task message (setup — no side effects)
 *   2. Transition label (commitment point — issue leaves queue)
 *   3. Apply labels, send notification
 *   4. Ensure session (fire-and-forget) + send to agent
 *   5. Update worker state
 *   6. Audit
 *
 * If setup fails, the issue stays in its queue untouched.
 * On state update failure after dispatch: logs warning (session IS running).
 */
export async function dispatchTask(
  opts: DispatchOpts,
): Promise<DispatchResult> {
  const {
    workspaceDir,
    agentId,
    project,
    issueId,
    issueTitle,
    issueDescription,
    issueUrl,
    role,
    level,
    fromLabel,
    toLabel,
    provider,
    pluginConfig,
    runtime,
  } = opts;

  const slotIndex = opts.slotIndex ?? 0;
  const rc = opts.runCommand;

  // ── Setup (no side effects — safe to fail) ──────────────────────────
  const resolvedConfig = await loadConfig(workspaceDir, project.name);
  const resolvedRole = resolvedConfig.roles[role];
  const { timeouts } = resolvedConfig;
  const model = resolveModel(role, level, resolvedRole);
  const roleWorker = getRoleWorker(project, role);
  const slot = roleWorker.levels[level]?.[slotIndex] ?? emptySlot();
  let existingSessionKey = slot.sessionKey;

  // Context budget check: clear session if over budget (unless same issue — feedback cycle)
  if (existingSessionKey && timeouts.sessionContextBudget < 1) {
    const shouldClear = await shouldClearSession(
      existingSessionKey,
      slot.issueId,
      issueId,
      timeouts,
      workspaceDir,
      project.name,
      rc,
    );
    if (shouldClear) {
      await updateSlot(workspaceDir, project.slug, role, level, slotIndex, {
        sessionKey: null,
      });
      existingSessionKey = null;
    }
  }

  // Compute session key deterministically (avoids waiting for gateway)
  // Slot name provides both collision prevention and human-readable identity
  const botName = slotName(project.name, role, level, slotIndex);
  const sessionKey = `agent:${agentId ?? "unknown"}:subagent:${project.name}-${role}-${level}-${botName.toLowerCase()}`;

  // Clear stale session key if it doesn't match the current deterministic key
  // (handles migration from old numeric format like ...-0 to name-based ...-Cordelia)
  if (existingSessionKey && existingSessionKey !== sessionKey) {
    // Delete the orphaned gateway session (fire-and-forget)
    rc(
      [
        "openclaw",
        "gateway",
        "call",
        "sessions.delete",
        "--params",
        JSON.stringify({ key: existingSessionKey }),
      ],
      { timeoutMs: 10_000 },
    ).catch(() => {});
    existingSessionKey = null;
  }

  const sessionAction = existingSessionKey ? "send" : "spawn";
  const dispatchAttempt = (slot.dispatchAttempt ?? 0) + 1;

  // Fetch comments to include in task context
  const comments = await provider.listComments(issueId);

  // Fetch PR context based on workflow role semantics (no hardcoded role/label checks)
  const { workflow } = resolvedConfig;
  const prFeedback = isFeedbackState(workflow, fromLabel)
    ? await fetchPrFeedback(provider, issueId)
    : undefined;
  const prContext = hasReviewCheck(workflow, role)
    ? await fetchPrContext(provider, issueId)
    : undefined;

  // Fetch attachment context (best-effort — never blocks dispatch)
  let attachmentContext: string | undefined;
  try {
    attachmentContext =
      (await formatAttachmentsForTask(workspaceDir, project.slug, issueId)) ||
      undefined;
  } catch {
    /* best-effort */
  }

  const primaryChannelId = project.channels[0]?.channelId ?? project.slug;
  const taskMessage = buildTaskMessage({
    projectName: project.name,
    channelId: primaryChannelId,
    role,
    issueId,
    issueTitle,
    issueDescription,
    issueUrl,
    repo: project.repo,
    baseBranch: project.baseBranch,
    comments,
    resolvedRole,
    prContext,
    prFeedback,
    attachmentContext,
  });

  // Load role-specific instructions to inject into the worker's system prompt
  const roleInstructions = await loadRoleInstructions(
    workspaceDir,
    project.name,
    role,
  );

  await auditLog(workspaceDir, "dispatch_attempt", {
    project: project.name,
    issue: issueId,
    issueTitle,
    role,
    level,
    sessionAction,
    sessionKey,
    fromLabel,
    toLabel,
    dispatchAttempt,
  });

  // Step 1: Ensure session exists (fire-and-forget)
  const sessionLabel = formatSessionLabel(project.name, role, level, botName);
  ensureSessionFireAndForget(
    sessionKey,
    model,
    workspaceDir,
    rc,
    timeouts.sessionPatchMs,
    sessionLabel,
  );

  // Step 2 (phase A): Attempt dispatch and require explicit acceptance
  const acceptance = await sendToAgent(sessionKey, taskMessage, {
    agentId,
    projectName: project.name,
    issueId,
    role,
    level,
    slotIndex,
    dispatchAttempt,
    orchestratorSessionKey: opts.sessionKey,
    workspaceDir,
    dispatchTimeoutMs: timeouts.dispatchMs,
    extraSystemPrompt: roleInstructions.trim() || undefined,
    model,
    runCommand: rc,
  });

  if (!acceptance.accepted) {
    // Persist nonce progression so retries use a fresh idempotency key.
    setInMemoryDispatchAttempt(
      project,
      role,
      level,
      slotIndex,
      dispatchAttempt,
    );
    await updateSlot(workspaceDir, project.slug, role, level, slotIndex, {
      dispatchAttempt,
    }).catch(() => {});
    await auditDispatchFailure(workspaceDir, {
      project: project.name,
      issueId,
      role,
      level,
      fromLabel,
      toLabel,
      sessionKey,
      dispatchAttempt,
      acceptance,
    });
    throw new Error(
      `dispatch ${acceptance.status}: ${acceptance.reason || "worker did not accept task"}`,
    );
  }

  // Step 3 (phase B): transition label now that acceptance is confirmed
  try {
    await provider.transitionLabel(issueId, fromLabel, toLabel);
  } catch (err) {
    // Worker already accepted task. Mark slot active anyway to prevent duplicate pickups.
    setInMemoryActiveState(project, role, level, slotIndex, {
      issueId,
      sessionKey,
      previousLabel: fromLabel,
      name: botName,
      dispatchAttempt,
    });
    try {
      await recordWorkerState(workspaceDir, project.slug, role, slotIndex, {
        issueId,
        level,
        sessionKey,
        sessionAction,
        fromLabel,
        name: botName,
        dispatchAttempt,
      });
    } catch (stateErr) {
      await auditLog(workspaceDir, "dispatch_warning", {
        step: "recordWorkerState_after_transition_failure",
        issue: issueId,
        role,
        sessionKey,
        error: (stateErr as Error).message ?? String(stateErr),
      });
    }
    await auditLog(workspaceDir, "dispatch_warning", {
      step: "transitionLabel_after_accept",
      issue: issueId,
      role,
      sessionKey,
      error: (err as Error).message ?? String(err),
    });
    throw new Error(
      `dispatch accepted but failed to transition ${fromLabel} → ${toLabel}: ${(err as Error).message ?? String(err)}`,
    );
  }

  // Mark issue + PR as managed and all consumed comments as seen (fire-and-forget)
  provider.reactToIssue(issueId, EYES_EMOJI).catch(() => {});
  provider.reactToPr(issueId, EYES_EMOJI).catch(() => {});
  acknowledgeComments(
    provider,
    issueId,
    comments,
    prFeedback,
    workspaceDir,
  ).catch((err) => {
    auditLog(workspaceDir, "dispatch_warning", {
      step: "acknowledgeComments",
      issue: issueId,
      error: (err as Error).message ?? String(err),
    }).catch(() => {});
  });

  // Apply role:level label (best-effort — failure must not abort dispatch)
  let issue: { labels: string[] } | undefined;
  try {
    issue = await provider.getIssue(issueId);
    const oldRoleLabels = issue.labels.filter((l) => l.startsWith(`${role}:`));
    if (oldRoleLabels.length > 0) {
      await provider.removeLabels(issueId, oldRoleLabels);
    }
    const roleLabel = `${role}:${level}:${botName}`;
    await provider.ensureLabel(roleLabel, getRoleLabelColor(role));
    await provider.addLabel(issueId, roleLabel);

    if (producesReviewableWork(workflow, role)) {
      const reviewLabel = resolveReviewRouting(
        workflow.reviewPolicy ?? ReviewPolicy.HUMAN,
        level,
      );
      const oldRouting = issue.labels.filter((l) => l.startsWith("review:"));
      if (oldRouting.length > 0)
        await provider.removeLabels(issueId, oldRouting);
      await provider.ensureLabel(reviewLabel, STEP_ROUTING_COLOR);
      await provider.addLabel(issueId, reviewLabel);
    }

    if (hasTestPhase(workflow)) {
      const testLabel = resolveTestRouting(
        workflow.testPolicy ?? TestPolicy.SKIP,
        level,
      );
      const oldTestRouting = issue.labels.filter((l) => l.startsWith("test:"));
      if (oldTestRouting.length > 0)
        await provider.removeLabels(issueId, oldTestRouting);
      await provider.ensureLabel(testLabel, STEP_ROUTING_COLOR);
      await provider.addLabel(issueId, testLabel);
    }

    if (opts.instanceName && !detectOwner(issue.labels)) {
      const ownerLabel = getOwnerLabel(opts.instanceName);
      await provider.ensureLabel(ownerLabel, OWNER_LABEL_COLOR);
      await provider.addLabel(issueId, ownerLabel);
    }
  } catch {
    // Best-effort — label failure must not abort dispatch
  }

  // Step 4: Worker-start notification only after acceptance+transition
  const notifyConfig = getNotificationConfig(pluginConfig);
  const notifyTarget = resolveNotifyChannel(
    issue?.labels ?? [],
    project.channels,
  );
  notify(
    {
      type: "workerStart",
      project: project.name,
      issueId,
      issueTitle,
      issueUrl,
      role,
      level,
      name: botName,
      sessionAction,
    },
    {
      workspaceDir,
      config: notifyConfig,
      channelId: notifyTarget?.channelId,
      channel: notifyTarget?.channel ?? "telegram",
      runtime,
      accountId: notifyTarget?.accountId,
      runCommand: rc,
    },
  ).catch((err) => {
    auditLog(workspaceDir, "dispatch_warning", {
      step: "notify",
      issue: issueId,
      role,
      error: (err as Error).message ?? String(err),
    }).catch(() => {});
  });

  // Step 5: Update worker state
  try {
    await recordWorkerState(workspaceDir, project.slug, role, slotIndex, {
      issueId,
      level,
      sessionKey,
      sessionAction,
      fromLabel,
      name: botName,
      dispatchAttempt,
    });
  } catch (err) {
    // Session is already dispatched — log warning but don't fail
    await auditLog(workspaceDir, "dispatch", {
      project: project.name,
      issue: issueId,
      role,
      warning: "State update failed after successful dispatch",
      error: (err as Error).message,
      sessionKey,
    });
  }

  // Step 6: Audit
  await auditDispatch(workspaceDir, {
    project: project.name,
    issueId,
    issueTitle,
    role,
    level,
    model,
    sessionAction,
    sessionKey,
    fromLabel,
    toLabel,
  });

  const announcement = buildAnnouncement(
    level,
    role,
    sessionAction,
    issueId,
    issueTitle,
    issueUrl,
    resolvedRole,
    botName,
  );

  return { sessionAction, sessionKey, level, model, announcement };
}

function ensureInMemorySlot(
  project: Project,
  role: string,
  level: string,
  slotIndex: number,
): {
  active: boolean;
  issueId: string | null;
  sessionKey: string | null;
  startTime: string | null;
  previousLabel?: string | null;
  name?: string;
  dispatchAttempt?: number;
} {
  if (!project.workers[role]) project.workers[role] = { levels: {} };
  if (!project.workers[role]!.levels[level])
    project.workers[role]!.levels[level] = [];
  const slots = project.workers[role]!.levels[level]!;
  while (slots.length <= slotIndex)
    slots.push({
      active: false,
      issueId: null,
      sessionKey: null,
      startTime: null,
    });
  return slots[slotIndex]!;
}

function setInMemoryDispatchAttempt(
  project: Project,
  role: string,
  level: string,
  slotIndex: number,
  dispatchAttempt: number,
): void {
  const slot = ensureInMemorySlot(project, role, level, slotIndex);
  slot.dispatchAttempt = dispatchAttempt;
}

function setInMemoryActiveState(
  project: Project,
  role: string,
  level: string,
  slotIndex: number,
  opts: {
    issueId: number;
    sessionKey: string;
    previousLabel?: string;
    name?: string;
    dispatchAttempt: number;
  },
): void {
  const slot = ensureInMemorySlot(project, role, level, slotIndex);
  slot.active = true;
  slot.issueId = String(opts.issueId);
  slot.sessionKey = opts.sessionKey;
  slot.startTime = new Date().toISOString();
  slot.previousLabel = opts.previousLabel;
  slot.name = opts.name;
  slot.dispatchAttempt = opts.dispatchAttempt;
}

async function recordWorkerState(
  workspaceDir: string,
  slug: string,
  role: string,
  slotIndex: number,
  opts: {
    issueId: number;
    level: string;
    sessionKey: string;
    sessionAction: "spawn" | "send";
    fromLabel?: string;
    name?: string;
    dispatchAttempt: number;
  },
): Promise<void> {
  await activateWorker(workspaceDir, slug, role, {
    issueId: String(opts.issueId),
    level: opts.level,
    sessionKey: opts.sessionKey,
    startTime: new Date().toISOString(),
    previousLabel: opts.fromLabel,
    slotIndex,
    name: opts.name,
    dispatchAttempt: opts.dispatchAttempt,
  });
}

async function auditDispatch(
  workspaceDir: string,
  opts: {
    project: string;
    issueId: number;
    issueTitle: string;
    role: string;
    level: string;
    model: string;
    sessionAction: string;
    sessionKey: string;
    fromLabel: string;
    toLabel: string;
  },
): Promise<void> {
  await auditLog(workspaceDir, "dispatch_accepted", {
    project: opts.project,
    issue: opts.issueId,
    issueTitle: opts.issueTitle,
    role: opts.role,
    level: opts.level,
    sessionAction: opts.sessionAction,
    sessionKey: opts.sessionKey,
    labelTransition: `${opts.fromLabel} → ${opts.toLabel}`,
  });
  await auditLog(workspaceDir, "dispatch", {
    project: opts.project,
    issue: opts.issueId,
    issueTitle: opts.issueTitle,
    role: opts.role,
    level: opts.level,
    sessionAction: opts.sessionAction,
    sessionKey: opts.sessionKey,
    labelTransition: `${opts.fromLabel} → ${opts.toLabel}`,
  });
  await auditLog(workspaceDir, "model_selection", {
    issue: opts.issueId,
    role: opts.role,
    level: opts.level,
    model: opts.model,
  });
}

async function auditDispatchFailure(
  workspaceDir: string,
  opts: {
    project: string;
    issueId: number;
    role: string;
    level: string;
    fromLabel: string;
    toLabel: string;
    sessionKey: string;
    dispatchAttempt: number;
    acceptance: DispatchAcceptance;
  },
): Promise<void> {
  const event =
    opts.acceptance.status === "rejected" ||
    opts.acceptance.status === "deduped"
      ? "dispatch_rejected"
      : "dispatch_failed";
  await auditLog(workspaceDir, event, {
    project: opts.project,
    issue: opts.issueId,
    role: opts.role,
    level: opts.level,
    sessionKey: opts.sessionKey,
    dispatchAttempt: opts.dispatchAttempt,
    fromLabel: opts.fromLabel,
    toLabel: opts.toLabel,
    status: opts.acceptance.status,
    runId: opts.acceptance.runId,
    reason: opts.acceptance.reason,
  });
}
