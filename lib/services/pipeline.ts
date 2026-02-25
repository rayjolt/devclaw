/**
 * Pipeline service — declarative completion rules.
 *
 * Uses workflow config to determine transitions and side effects.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { CiState, type StateLabel, type IssueProvider } from "../providers/provider.js";
import { deactivateWorker, loadProjectBySlug, getRoleWorker } from "../projects/index.js";
import type { RunCommand } from "../context.js";
import { notify, getNotificationConfig } from "../dispatch/notify.js";
import { log as auditLog } from "../audit.js";
import { loadConfig } from "../config/index.js";
import { detectStepRouting } from "./queue-scan.js";
import { ciDiagnostics, getCiStatusWithRetry } from "./ci-gate.js";
import {
  DEFAULT_WORKFLOW,
  Action,
  getCompletionRule,
  getNextStateDescription,
  getCompletionEmoji,
  resolveNotifyChannel,
  type CompletionRule,
  type WorkflowConfig,
} from "../workflow/index.js";
import type { Channel } from "../projects/index.js";

export type { CompletionRule };

export type CompletionOutput = {
  labelTransition: string;
  announcement: string;
  nextState: string;
  prUrl?: string;
  issueUrl?: string;
  issueClosed?: boolean;
  issueReopened?: boolean;
};

/**
 * Get completion rule for a role:result pair.
 * Uses workflow config when available.
 */
export function getRule(
  role: string,
  result: string,
  workflow: WorkflowConfig = DEFAULT_WORKFLOW,
): CompletionRule | undefined {
  return getCompletionRule(workflow, role, result) ?? undefined;
}

/**
 * Execute the completion side-effects for a role:result pair.
 */
export async function executeCompletion(opts: {
  workspaceDir: string;
  projectSlug: string;
  role: string;
  result: string;
  issueId: number;
  summary?: string;
  prUrl?: string;
  provider: IssueProvider;
  repoPath: string;
  projectName: string;
  channels: Channel[];
  pluginConfig?: Record<string, unknown>;
  /** Plugin runtime for direct API access (avoids CLI subprocess timeouts) */
  runtime?: PluginRuntime;
  /** Workflow config (defaults to DEFAULT_WORKFLOW) */
  workflow?: WorkflowConfig;
  /** Tasks created during this work session (e.g. architect implementation tasks) */
  createdTasks?: Array<{ id: number; title: string; url: string }>;
  /** Level of the completing worker */
  level?: string;
  /** Slot index within the level's array */
  slotIndex?: number;
  runCommand: RunCommand;
}): Promise<CompletionOutput> {
  const rc = opts.runCommand;
  const {
    workspaceDir, projectSlug, role, result, issueId, summary, provider,
    repoPath, projectName, channels, pluginConfig, runtime,
    workflow = DEFAULT_WORKFLOW,
    createdTasks,
  } = opts;

  const key = `${role}:${result}`;
  const rule = getCompletionRule(workflow, role, result);
  if (!rule) throw new Error(`No completion rule for ${key}`);

  const { timeouts } = await loadConfig(workspaceDir, projectName);
  let prUrl = opts.prUrl;
  let mergedPr = false;
  let prTitle: string | undefined;
  let sourceBranch: string | undefined;
  let ciOverrideToLabel: string | null = null;

  // Execute pre-notification actions
  for (const action of rule.actions) {
    switch (action) {
      case Action.GIT_PULL:
        try { await rc(["git", "pull"], { timeoutMs: timeouts.gitPullMs, cwd: repoPath }); } catch (err) {
          auditLog(workspaceDir, "pipeline_warning", { step: "gitPull", issue: issueId, role, error: (err as Error).message ?? String(err) }).catch(() => {});
        }
        break;
      case Action.DETECT_PR:
        if (!prUrl) { try {
          // Try open PR first (developer just finished — MR is still open), fall back to merged
          const prStatus = await provider.getPrStatus(issueId);
          prUrl = prStatus.url ?? await provider.getMergedMRUrl(issueId) ?? undefined;
          prTitle = prStatus.title;
          sourceBranch = prStatus.sourceBranch;
        } catch (err) {
          auditLog(workspaceDir, "pipeline_warning", { step: "detectPr", issue: issueId, role, error: (err as Error).message ?? String(err) }).catch(() => {});
        } }
        break;
      case Action.MERGE_PR:
        try {
          // Grab PR metadata before merging (the MR is still open at this point)
          if (!prTitle) {
            try {
              const prStatus = await provider.getPrStatus(issueId);
              prUrl = prUrl ?? prStatus.url ?? undefined;
              prTitle = prStatus.title;
              sourceBranch = prStatus.sourceBranch;
            } catch { /* best-effort */ }
          }

          if (workflow.ciGating) {
            const { status: ci } = await getCiStatusWithRetry(provider, issueId, 3);
            const reason = ciDiagnostics(ci);
            if (ci.state === CiState.PENDING) {
              ciOverrideToLabel = rule.from; // keep current state until CI completes
              try { await provider.addComment(issueId, `⏳ CI gate: ${reason}`); } catch { /* best effort */ }
              auditLog(workspaceDir, "pipeline_warning", { step: "mergePrCiPending", issue: issueId, role, reason }).catch(() => {});
              break;
            }
            if (ci.state === CiState.FAIL || ci.state === CiState.UNKNOWN) {
              ciOverrideToLabel = resolveCiFailureLabel(workflow, rule.from) ?? rule.from;
              try { await provider.addComment(issueId, `⚠️ CI gate blocked completion: ${reason}`); } catch { /* best effort */ }
              auditLog(workspaceDir, "pipeline_warning", { step: "mergePrCiBlocked", issue: issueId, role, reason, failedChecks: ci.failedChecks, pendingChecks: ci.pendingChecks }).catch(() => {});
              break;
            }
          }

          await provider.mergePr(issueId);
          mergedPr = true;
        } catch (err) {
          auditLog(workspaceDir, "pipeline_warning", { step: "mergePr", issue: issueId, role, error: (err as Error).message ?? String(err) }).catch(() => {});
        }
        break;
    }
  }

  // Get issue early (for URL in notification + channel routing)
  const issue = await provider.getIssue(issueId);
  const notifyTarget = resolveNotifyChannel(issue.labels, channels);

  // Get next state description from workflow
  const nextState = getNextStateDescription(workflow, role, result);

  // Retrieve worker name from project state (best-effort)
  let workerName: string | undefined;
  try {
    const project = await loadProjectBySlug(workspaceDir, projectSlug);
    if (project && opts.level !== undefined && opts.slotIndex !== undefined) {
      const roleWorker = getRoleWorker(project, role);
      const slot = roleWorker.levels[opts.level]?.[opts.slotIndex];
      workerName = slot?.name;
    }
  } catch {
    // Best-effort — don't fail notification if name retrieval fails
  }

  // Send notification early (before deactivation and label transition which can fail)
  const notifyConfig = getNotificationConfig(pluginConfig);
  notify(
    {
      type: "workerComplete",
      project: projectName,
      issueId,
      issueUrl: issue.web_url,
      role,
      level: opts.level,
      name: workerName,
      result: result as "done" | "pass" | "fail" | "refine" | "blocked",
      summary,
      nextState,
      prUrl,
      createdTasks,
    },
    {
      workspaceDir,
      config: notifyConfig,
      channelId: notifyTarget?.channelId,
      channel: notifyTarget?.channel ?? "telegram",
      runtime,
      accountId: notifyTarget?.accountId,
    },
  ).catch((err) => {
    auditLog(workspaceDir, "pipeline_warning", { step: "notify", issue: issueId, role, error: (err as Error).message ?? String(err) }).catch(() => {});
  });

  // Send merge notification when PR was merged during this completion
  if (mergedPr) {
    notify(
      {
        type: "prMerged",
        project: projectName,
        issueId,
        issueUrl: issue.web_url,
        issueTitle: issue.title,
        prUrl,
        prTitle,
        sourceBranch,
        mergedBy: "pipeline",
      },
      { workspaceDir, config: notifyConfig, channelId: notifyTarget?.channelId, channel: notifyTarget?.channel ?? "telegram", runtime, accountId: notifyTarget?.accountId },
    ).catch((err) => {
      auditLog(workspaceDir, "pipeline_warning", { step: "mergeNotify", issue: issueId, role, error: (err as Error).message ?? String(err) }).catch(() => {});
    });
  }

  // Transition label first (critical — if this fails, issue still has correct state)
  // Then execute post-transition actions (close/reopen)
  // Finally deactivate worker (last — ensures label is set even if deactivation fails)
  
  const effectiveTo = ciOverrideToLabel ?? (rule.to as StateLabel);
  const transitioned = effectiveTo !== rule.from;
  if (transitioned) {
    await provider.transitionLabel(issueId, rule.from as StateLabel, effectiveTo as StateLabel);
  }

  // Execute post-transition actions only on the primary success/failure rule path.
  // If CI gating overrides/blocks the transition, side effects must not run.
  const runPostActions = transitioned && effectiveTo === rule.to;
  if (runPostActions) {
    for (const action of rule.actions) {
      switch (action) {
        case Action.CLOSE_ISSUE:
          await provider.closeIssue(issueId);
          break;
        case Action.REOPEN_ISSUE:
          await provider.reopenIssue(issueId);
          break;
      }
    }
  }

  // Deactivate worker last (non-critical — session cleanup)
  await deactivateWorker(workspaceDir, projectSlug, role, { level: opts.level, slotIndex: opts.slotIndex, issueId: String(issueId) });

  // Send review routing notification when developer completes
  if (role === "developer" && result === "done") {
    // Re-fetch issue to get labels after transition
    const updated = await provider.getIssue(issueId);
    const routing = detectStepRouting(updated.labels, "review") as "human" | "agent" | null;
    if (routing === "human" || routing === "agent") {
      notify(
        {
          type: "reviewNeeded",
          project: projectName,
          issueId,
          issueUrl: updated.web_url,
          issueTitle: updated.title,
          routing,
          prUrl,
        },
        {
          workspaceDir,
          config: notifyConfig,
          channelId: notifyTarget?.channelId,
          channel: notifyTarget?.channel ?? "telegram",
          runtime,
          accountId: notifyTarget?.accountId,
        },
      ).catch((err) => {
        auditLog(workspaceDir, "pipeline_warning", { step: "reviewNotify", issue: issueId, role, error: (err as Error).message ?? String(err) }).catch(() => {});
      });
    }
  }

  // Build announcement using workflow-derived emoji
  const emoji = getCompletionEmoji(role, result);
  const label = key.replace(":", " ").toUpperCase();
  let announcement = `${emoji} ${label} #${issueId}`;
  if (summary) announcement += ` — ${summary}`;
  announcement += `\n📋 [Issue #${issueId}](${issue.web_url})`;
  if (prUrl) announcement += `\n🔗 [PR](${prUrl})`;
  if (createdTasks && createdTasks.length > 0) {
    announcement += `\n📌 Created tasks:`;
    for (const t of createdTasks) {
      announcement += `\n  - [#${t.id}: ${t.title}](${t.url})`;
    }
  }
  const effectiveNextState = ciOverrideToLabel && ciOverrideToLabel !== rule.to
    ? `CI gate applied (${rule.from} → ${ciOverrideToLabel})`
    : nextState;

  announcement += `\n${effectiveNextState}.`;

  return {
    labelTransition: `${rule.from} → ${effectiveTo}`,
    announcement,
    nextState: effectiveNextState,
    prUrl,
    issueUrl: issue.web_url,
    issueClosed: runPostActions && rule.actions.includes(Action.CLOSE_ISSUE),
    issueReopened: runPostActions && rule.actions.includes(Action.REOPEN_ISSUE),
  };
}

function resolveCiFailureLabel(workflow: WorkflowConfig, fromLabel: string): string | null {
  const state = Object.values(workflow.states).find((s) => s.label === fromLabel);
  if (!state?.on) return null;

  const candidates = ["CHANGES_REQUESTED", "REJECT", "FAIL", "MERGE_FAILED"];
  for (const event of candidates) {
    const transition = state.on[event];
    if (!transition) continue;
    const targetKey = typeof transition === "string" ? transition : transition.target;
    const target = workflow.states[targetKey];
    if (target) return target.label;
  }
  return null;
}
