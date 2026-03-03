/**
 * Pipeline service — declarative completion rules.
 *
 * Uses workflow config to determine transitions and side effects.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { randomUUID } from "node:crypto";
import {
  CiState,
  type IssueProvider,
  type StateLabel,
} from "../providers/provider.js";
import {
  deactivateWorker,
  getRoleWorker,
  loadProjectBySlug,
} from "../projects/index.js";
import type { RunCommand } from "../context.js";
import { getNotificationConfig, notify } from "../dispatch/notify.js";
import { log as auditLog } from "../audit.js";
import { loadConfig } from "../config/index.js";
import { detectStepRouting } from "./queue-scan.js";
import { ciDiagnostics, getCiStatusWithRetry } from "./ci-gate.js";
import { guardTerminalCompletion } from "./terminal-guard.js";
import {
  Action,
  DEFAULT_WORKFLOW,
  getCompletionEmoji,
  getCompletionRule,
  getStateLabels,
  getNextStateDescription,
  resolveNotifyChannel,
  findStateByLabel,
  type CompletionRule,
  type WorkflowConfig,
} from "../workflow/index.js";
import type { Channel } from "../projects/index.js";

export type { CompletionRule };

export type CompletionOutput = {
  labelTransition: string;
  announcement: string;
  nextState: string;
  correlationId: string;
  transitionAttempts: number;
  prUrl?: string;
  issueUrl?: string;
  issueClosed?: boolean;
  issueReopened?: boolean;
};

export function getRule(
  role: string,
  result: string,
  workflow: WorkflowConfig = DEFAULT_WORKFLOW,
): CompletionRule | undefined {
  return getCompletionRule(workflow, role, result) ?? undefined;
}

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
  runtime?: PluginRuntime;
  workflow?: WorkflowConfig;
  createdTasks?: Array<{ id: number; title: string; url: string }>;
  level?: string;
  slotIndex?: number;
  runCommand: RunCommand;
}): Promise<CompletionOutput> {
  const rc = opts.runCommand;
  const {
    workspaceDir,
    projectSlug,
    role,
    result,
    issueId,
    summary,
    provider,
    repoPath,
    projectName,
    channels,
    pluginConfig,
    runtime,
    workflow = DEFAULT_WORKFLOW,
    createdTasks,
  } = opts;

  const key = `${role}:${result}`;
  const correlationId = randomUUID();
  const rule = getCompletionRule(workflow, role, result);
  if (!rule) throw new Error(`No completion rule for ${key}`);

  const { timeouts } = await loadConfig(workspaceDir, projectName);
  let prUrl = opts.prUrl;
  let mergedPr = false;
  let prTitle: string | undefined;
  let sourceBranch: string | undefined;
  let ciOverrideToLabel: string | null = null;
  let terminalGuardOverrideToLabel: string | null = null;
  let terminalGuardReason: string | null = null;

  // IMPORTANT: pre-terminal guard must run before any terminal side effects.
  // Pipeline actions can include side effects (merge, close) — so we compute the
  // guard upfront and then skip any terminal actions if the guard blocks.
  const intendedTargetState = findStateByLabel(workflow, rule.to);
  const terminalGuard = intendedTargetState
    ? await guardTerminalCompletion({
        workflow,
        provider,
        issueId,
        fromLabel: rule.from,
        toState: intendedTargetState,
        actions: rule.actions,
      })
    : null;

  const terminalBlocked = terminalGuard?.allow === false;
  if (terminalGuard && terminalGuard.allow === false) {
    const pr = terminalGuard.prStatus;
    const guardPrUrl = pr?.url ?? null;
    terminalGuardReason = terminalGuard.reason;
    terminalGuardOverrideToLabel = terminalGuard.toLabel ?? rule.from;

    // Best-effort: leave breadcrumbs for humans.
    try {
      if (terminalGuard.reason === "merge_conflict") {
        await provider.addComment(
          issueId,
          `⚠️ DevClaw blocked terminal completion: PR has merge conflicts (${guardPrUrl ?? "no PR url"}).`,
        );
      } else if (terminalGuard.reason === "pr_not_merged_auto_merge_off") {
        await provider.addComment(
          issueId,
          `⏸️ DevClaw blocked terminal completion: auto-merge is off and PR is not merged yet (${guardPrUrl ?? "no PR url"}). Merge the PR, then DevClaw will close this issue.`,
        );
      } else if (terminalGuard.reason === "pr_closed_unmerged") {
        await provider.addComment(
          issueId,
          `⚠️ DevClaw blocked terminal completion: PR was closed without merging (${guardPrUrl ?? "no PR url"}).`,
        );
      } else {
        await provider.addComment(
          issueId,
          "⚠️ DevClaw blocked terminal completion: unable to verify PR mergeability/merge state.",
        );
      }
    } catch {
      /* best-effort */
    }

    await auditLog(workspaceDir, "terminal_completion_blocked", {
      project: projectName,
      issueId,
      from: rule.from,
      intendedTo: rule.to,
      reason: terminalGuard.reason,
      prUrl: guardPrUrl,
      prState: pr?.state,
      mergeable: pr?.mergeable,
      correlationId,
      path: "pipeline",
    }).catch(() => {});
  }

  for (const action of rule.actions) {
    switch (action) {
      case Action.GIT_PULL:
        try {
          await rc(["git", "pull"], {
            timeoutMs: timeouts.gitPullMs,
            cwd: repoPath,
          });
        } catch (err) {
          auditLog(workspaceDir, "pipeline_warning", {
            step: "gitPull",
            issue: issueId,
            role,
            correlationId,
            error: (err as Error).message ?? String(err),
          }).catch(() => {});
        }
        break;
      case Action.DETECT_PR:
        if (!prUrl) {
          try {
            const prStatus = await provider.getPrStatus(issueId);
            prUrl =
              prStatus.url ??
              (await provider.getMergedMRUrl(issueId)) ??
              undefined;
            prTitle = prStatus.title;
            sourceBranch = prStatus.sourceBranch;
          } catch (err) {
            auditLog(workspaceDir, "pipeline_warning", {
              step: "detectPr",
              issue: issueId,
              role,
              correlationId,
              error: (err as Error).message ?? String(err),
            }).catch(() => {});
          }
        }
        break;
      case Action.MERGE_PR:
        // If the pre-terminal guard blocks, do not attempt terminal side effects.
        if (terminalBlocked) break;
        try {
          if (!prTitle) {
            try {
              const prStatus = await provider.getPrStatus(issueId);
              prUrl = prUrl ?? prStatus.url ?? undefined;
              prTitle = prStatus.title;
              sourceBranch = prStatus.sourceBranch;
            } catch {
              /* best-effort */
            }
          }

          if (workflow.ciGating) {
            const { status: ci } = await getCiStatusWithRetry(
              provider,
              issueId,
              3,
            );
            const reason = ciDiagnostics(ci);
            if (ci.state === CiState.PENDING) {
              ciOverrideToLabel = rule.from;
              try {
                await provider.addComment(issueId, `⏳ CI gate: ${reason}`);
              } catch {
                /* best effort */
              }
              auditLog(workspaceDir, "pipeline_warning", {
                step: "mergePrCiPending",
                issue: issueId,
                role,
                reason,
                correlationId,
              }).catch(() => {});
              break;
            }
            if (ci.state === CiState.FAIL || ci.state === CiState.UNKNOWN) {
              ciOverrideToLabel =
                resolveCiFailureLabel(workflow, rule.from) ?? rule.from;
              try {
                await provider.addComment(
                  issueId,
                  `⚠️ CI gate blocked completion: ${reason}`,
                );
              } catch {
                /* best effort */
              }
              auditLog(workspaceDir, "pipeline_warning", {
                step: "mergePrCiBlocked",
                issue: issueId,
                role,
                reason,
                correlationId,
                failedChecks: ci.failedChecks,
                pendingChecks: ci.pendingChecks,
              }).catch(() => {});
              break;
            }
          }

          await provider.mergePr(issueId);
          mergedPr = true;
        } catch (err) {
          auditLog(workspaceDir, "pipeline_warning", {
            step: "mergePr",
            issue: issueId,
            role,
            correlationId,
            error: (err as Error).message ?? String(err),
          }).catch(() => {});
        }
        break;
    }
  }

  const issueBefore = await provider.getIssue(issueId);
  const notifyTarget = resolveNotifyChannel(issueBefore.labels, channels);
  let nextState = getNextStateDescription(workflow, role, result);
  const notifyConfig = getNotificationConfig(pluginConfig);


  if (terminalBlocked && terminalGuardReason) {
    nextState = `blocked: ${terminalGuardReason}`;
  }

  let workerName: string | undefined;
  try {
    const project = await loadProjectBySlug(workspaceDir, projectSlug);
    if (project && opts.level !== undefined && opts.slotIndex !== undefined) {
      const roleWorker = getRoleWorker(project, role);
      const slot = roleWorker.levels[opts.level]?.[opts.slotIndex];
      workerName = slot?.name;
    }
  } catch {
    // best-effort
  }

  const effectiveTo = (terminalGuardOverrideToLabel ?? ciOverrideToLabel ?? (rule.to as StateLabel)) as StateLabel;
  const transitioned = effectiveTo !== rule.from;

  let updatedIssue = issueBefore;
  let transitionAttempts = 0;
  if (transitioned) {
    const transitionResult = await transitionLabelWithVerification({
      provider,
      issueId,
      from: rule.from as StateLabel,
      to: effectiveTo as StateLabel,
      workflow,
      correlationId,
      workspaceDir,
      role,
    });
    transitionAttempts = transitionResult.attempts;
    updatedIssue = transitionResult.issue;
  }

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

  await deactivateWorker(workspaceDir, projectSlug, role, {
    level: opts.level,
    slotIndex: opts.slotIndex,
    issueId: String(issueId),
  });

  notify(
    {
      type: "workerComplete",
      project: projectName,
      issueId,
      issueUrl: updatedIssue.web_url,
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
    auditLog(workspaceDir, "pipeline_warning", {
      step: "notify",
      issue: issueId,
      role,
      correlationId,
      error: (err as Error).message ?? String(err),
    }).catch(() => {});
  });

  if (mergedPr) {
    notify(
      {
        type: "prMerged",
        project: projectName,
        issueId,
        issueUrl: updatedIssue.web_url,
        issueTitle: updatedIssue.title,
        prUrl,
        prTitle,
        sourceBranch,
        mergedBy: "pipeline",
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
      auditLog(workspaceDir, "pipeline_warning", {
        step: "mergeNotify",
        issue: issueId,
        role,
        correlationId,
        error: (err as Error).message ?? String(err),
      }).catch(() => {});
    });
  }

  if (role === "developer" && result === "done") {
    const routing = detectStepRouting(updatedIssue.labels, "review") as
      | "human"
      | "agent"
      | null;
    if (routing === "human" || routing === "agent") {
      notify(
        {
          type: "reviewNeeded",
          project: projectName,
          issueId,
          issueUrl: updatedIssue.web_url,
          issueTitle: updatedIssue.title,
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
        auditLog(workspaceDir, "pipeline_warning", {
          step: "reviewNotify",
          issue: issueId,
          role,
          correlationId,
          error: (err as Error).message ?? String(err),
        }).catch(() => {});
      });
    }
  }

  const emoji = getCompletionEmoji(role, result);
  const label = key.replace(":", " ").toUpperCase();
  let announcement = `${emoji} ${label} #${issueId}`;
  if (summary) announcement += ` — ${summary}`;
  announcement += `\n📋 [Issue #${issueId}](${updatedIssue.web_url})`;
  if (prUrl) announcement += `\n🔗 [PR](${prUrl})`;
  if (createdTasks && createdTasks.length > 0) {
    announcement += `\n📌 Created tasks:`;
    for (const t of createdTasks) {
      announcement += `\n  - [#${t.id}: ${t.title}](${t.url})`;
    }
  }
  const effectiveNextState =
    terminalGuardReason
      ? `Terminal guard blocked completion (${terminalGuardReason})`
      : (ciOverrideToLabel && ciOverrideToLabel !== rule.to
        ? `CI gate applied (${rule.from} → ${ciOverrideToLabel})`
        : nextState);

  announcement += `\n${effectiveNextState}.`;

  return {
    labelTransition: `${rule.from} → ${effectiveTo}`,
    announcement,
    nextState: effectiveNextState,
    correlationId,
    transitionAttempts,
    prUrl,
    issueUrl: updatedIssue.web_url,
    issueClosed: runPostActions && rule.actions.includes(Action.CLOSE_ISSUE),
    issueReopened: runPostActions && rule.actions.includes(Action.REOPEN_ISSUE),
  };
}

async function transitionLabelWithVerification(opts: {
  provider: IssueProvider;
  issueId: number;
  from: StateLabel;
  to: StateLabel;
  workflow: WorkflowConfig;
  correlationId: string;
  workspaceDir: string;
  role: string;
}): Promise<{
  attempts: number;
  issue: Awaited<ReturnType<IssueProvider["getIssue"]>>;
}> {
  const maxAttempts = 3;
  let lastError: unknown = null;
  const stateLabels = getStateLabels(opts.workflow);
  const staleStateLabels = (labels: string[]) =>
    labels.filter(
      (label) => stateLabels.includes(label as StateLabel) && label !== opts.to,
    );

  const before = await opts.provider.getIssue(opts.issueId);
  const staleBefore = staleStateLabels(before.labels);
  if (before.labels.includes(opts.to) && staleBefore.length === 0) {
    await auditLog(opts.workspaceDir, "pipeline_transition_already_applied", {
      issue: opts.issueId,
      role: opts.role,
      from: opts.from,
      to: opts.to,
      correlationId: opts.correlationId,
    }).catch(() => {});
    return { attempts: 0, issue: before };
  }
  if (!before.labels.includes(opts.from) && !before.labels.includes(opts.to)) {
    throw new Error(
      `Completion transition precondition failed for issue #${opts.issueId}: expected current label "${opts.from}" or already-transitioned "${opts.to}", got [${before.labels.join(", ")}] [correlationId=${opts.correlationId}]`,
    );
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await opts.provider.transitionLabel(opts.issueId, opts.from, opts.to);
      const issue = await opts.provider.getIssue(opts.issueId);
      if (!issue.labels.includes(opts.to)) {
        throw new Error(
          `Transition verification failed: issue #${opts.issueId} missing target label "${opts.to}" after transition`,
        );
      }
      const staleAfter = staleStateLabels(issue.labels);
      if (staleAfter.length > 0) {
        throw new Error(
          `Transition verification failed: issue #${opts.issueId} still has stale state labels [${staleAfter.join(", ")}] after transition`,
        );
      }

      await auditLog(opts.workspaceDir, "pipeline_transition_verified", {
        issue: opts.issueId,
        role: opts.role,
        from: opts.from,
        to: opts.to,
        attempt,
        correlationId: opts.correlationId,
      }).catch(() => {});

      return { attempts: attempt, issue };
    } catch (err) {
      lastError = err;
      await auditLog(opts.workspaceDir, "pipeline_transition_attempt_failed", {
        issue: opts.issueId,
        role: opts.role,
        from: opts.from,
        to: opts.to,
        attempt,
        correlationId: opts.correlationId,
        error: (err as Error).message ?? String(err),
      }).catch(() => {});

      if (attempt < maxAttempts) await sleep(150 * attempt);
    }
  }

  throw new Error(
    `Completion transition failed for issue #${opts.issueId} (${opts.from} → ${opts.to}) ` +
      `[correlationId=${opts.correlationId}] after ${maxAttempts} attempts: ${(lastError as Error)?.message ?? String(lastError)}`,
  );
}

function resolveCiFailureLabel(
  workflow: WorkflowConfig,
  fromLabel: string,
): string | null {
  const state = Object.values(workflow.states).find(
    (s) => s.label === fromLabel,
  );
  if (!state?.on) return null;

  const candidates = ["CHANGES_REQUESTED", "REJECT", "FAIL", "MERGE_FAILED"];
  for (const event of candidates) {
    const transition = state.on[event];
    if (!transition) continue;
    const targetKey =
      typeof transition === "string" ? transition : transition.target;
    const target = workflow.states[targetKey];
    if (target) return target.label;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
