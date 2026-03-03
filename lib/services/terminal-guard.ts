/**
 * terminal-guard.ts — Shared guard that prevents terminal completion when PR state makes it unsafe.
 *
 * Invariants:
 * - Never allow terminal completion if PR is conflicting (mergeable === false).
 * - When auto-merge is off for the completion path (no mergePr action), do not allow
 *   terminal completion until provider reports PR is merged.
 */

import type { IssueProvider, PrStatus } from "../providers/provider.js";
import { PrState } from "../providers/provider.js";
import {
  Action,
  StateType,
  type StateConfig,
  type WorkflowConfig,
} from "../workflow/index.js";
import { findStateByLabel, getRevertLabel } from "../workflow/queries.js";

export type TerminalGuardDecision =
  | {
      allow: true;
      prStatus?: PrStatus;
    }
  | {
      allow: false;
      /** Suggested label to transition to (optional). If omitted, caller should stay put. */
      toLabel?: string;
      reason:
        | "merge_conflict"
        | "pr_not_merged_auto_merge_off"
        | "pr_closed_unmerged"
        | "pr_status_unavailable";
      prStatus?: PrStatus;
    };

function getFeedbackLabel(workflow: WorkflowConfig): string {
  // Prefer canonical label if present.
  const toImprove = findStateByLabel(workflow, "To Improve");
  if (toImprove) return toImprove.label;
  // Fallback: developer revert queue.
  try {
    return getRevertLabel(workflow, "developer");
  } catch {
    return "To Improve";
  }
}

function isTerminalPath(toState: StateConfig, actions: string[] | undefined): boolean {
  if (toState.type === StateType.TERMINAL) return true;
  if ((actions ?? []).includes(Action.CLOSE_ISSUE)) return true;
  return false;
}

/**
 * Decide whether a transition that would complete an issue is allowed.
 */
export async function guardTerminalCompletion(opts: {
  workflow: WorkflowConfig;
  provider: IssueProvider;
  issueId: number;
  fromLabel: string;
  toState: StateConfig;
  actions?: string[];
}): Promise<TerminalGuardDecision> {
  const { workflow, provider, issueId, toState, actions } = opts;

  if (!isTerminalPath(toState, actions)) return { allow: true };

  let prStatus: PrStatus;
  try {
    prStatus = await provider.getPrStatus(issueId);
  } catch {
    return {
      allow: false,
      reason: "pr_status_unavailable",
    };
  }

  // No PR associated (or provider couldn't find one): allow completion.
  if (!prStatus.url) return { allow: true, prStatus };

  // Conflicts always block and route to feedback.
  if (prStatus.mergeable === false) {
    return {
      allow: false,
      toLabel: getFeedbackLabel(workflow),
      reason: "merge_conflict",
      prStatus,
    };
  }

  // Closed but not merged: treat as unmerged and route to feedback.
  if (prStatus.state === PrState.CLOSED) {
    return {
      allow: false,
      toLabel: getFeedbackLabel(workflow),
      reason: "pr_closed_unmerged",
      prStatus,
    };
  }

  // Auto-merge is considered "on" for this path only if mergePr is present.
  const autoMergeEnabled = (actions ?? []).includes(Action.MERGE_PR);

  if (!autoMergeEnabled && prStatus.state !== PrState.MERGED) {
    return {
      allow: false,
      reason: "pr_not_merged_auto_merge_off",
      prStatus,
    };
  }

  return { allow: true, prStatus };
}
