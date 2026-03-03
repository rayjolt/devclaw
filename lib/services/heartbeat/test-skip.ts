/**
 * test-skip.ts — Auto-transition test:skip issues through the test queue.
 *
 * When testPolicy is "skip" (default), issues arrive in the test queue
 * with a test:skip label. This pass auto-transitions them to done,
 * executing the SKIP event's configured actions (e.g. closeIssue).
 *
 * Mirrors reviewPass() in review.ts — called by the heartbeat service.
 */
import type { IssueProvider } from "../../providers/provider.js";
import {
  Action,
  StateType,
  WorkflowEvent,
  type WorkflowConfig,
  type StateConfig,
} from "../../workflow/index.js";
import { detectStepRouting } from "../queue-scan.js";
import { log as auditLog } from "../../audit.js";
import { guardTerminalCompletion } from "../terminal-guard.js";

/**
 * Scan test queue states and auto-transition issues with test:skip.
 * Returns the number of transitions made.
 */
export async function testSkipPass(opts: {
  workspaceDir: string;
  projectName: string;
  workflow: WorkflowConfig;
  provider: IssueProvider;
}): Promise<number> {
  const { workspaceDir, projectName, workflow, provider } = opts;
  let transitions = 0;

  // Find test queue states (role=tester, type=queue) that have a SKIP event
  const testQueueStates = Object.entries(workflow.states)
    .filter(([, s]) => s.role === "tester" && s.type === StateType.QUEUE) as [string, StateConfig][];

  for (const [_stateKey, state] of testQueueStates) {
    const skipTransition = state.on?.[WorkflowEvent.SKIP];
    if (!skipTransition) continue;

    const targetKey = typeof skipTransition === "string" ? skipTransition : skipTransition.target;
    const actions = typeof skipTransition === "object" ? skipTransition.actions : undefined;
    const targetState = workflow.states[targetKey];
    if (!targetState) continue;

    const issues = await provider.listIssuesByLabel(state.label);
    for (const issue of issues) {
      const routing = detectStepRouting(issue.labels, "test");
      if (routing !== "skip") continue;

      // Pre-terminal guard: never allow Done/closeIssue if PR is conflicting or not merged (auto-merge off).
      const guard = await guardTerminalCompletion({
        workflow,
        provider,
        issueId: issue.iid,
        fromLabel: state.label,
        toState: targetState,
        actions,
      });

      if (!guard.allow) {
        const pr = guard.prStatus;
        const prUrl = pr?.url ?? null;

        // Best-effort: leave a clear breadcrumb.
        try {
          if (guard.reason === "merge_conflict") {
            await provider.addComment(issue.iid, `⚠️ DevClaw blocked terminal completion: PR has merge conflicts (${prUrl ?? "no PR url"}).`);
          } else if (guard.reason === "pr_not_merged_auto_merge_off") {
            await provider.addComment(issue.iid, `⏸️ DevClaw blocked terminal completion: auto-merge is off and PR is not merged yet (${prUrl ?? "no PR url"}). Merge the PR, then the heartbeat will close this issue.`);
          } else if (guard.reason === "pr_closed_unmerged") {
            await provider.addComment(issue.iid, `⚠️ DevClaw blocked terminal completion: PR was closed without merging (${prUrl ?? "no PR url"}).`);
          } else {
            await provider.addComment(issue.iid, "⚠️ DevClaw blocked terminal completion: unable to verify PR mergeability/merge state.");
          }
        } catch { /* best-effort */ }

        await auditLog(workspaceDir, "terminal_completion_blocked", {
          project: projectName,
          issueId: issue.iid,
          from: state.label,
          intendedTo: targetState.label,
          reason: guard.reason,
          prUrl,
          prState: pr?.state,
          mergeable: pr?.mergeable,
        });

        if (guard.toLabel) {
          await provider.transitionLabel(issue.iid, state.label, guard.toLabel);
          await auditLog(workspaceDir, "terminal_guard_transition", {
            project: projectName,
            issueId: issue.iid,
            from: state.label,
            to: guard.toLabel,
            reason: guard.reason,
            prUrl,
          });
          transitions++;
        }

        continue;
      }

      // Execute SKIP transition actions
      if (actions) {
        for (const action of actions) {
          switch (action) {
            case Action.CLOSE_ISSUE:
              try { await provider.closeIssue(issue.iid); } catch { /* best-effort */ }
              break;
            case Action.REOPEN_ISSUE:
              try { await provider.reopenIssue(issue.iid); } catch { /* best-effort */ }
              break;
          }
        }
      }

      // Transition label
      await provider.transitionLabel(issue.iid, state.label, targetState.label);

      await auditLog(workspaceDir, "test_skip_transition", {
        project: projectName,
        issueId: issue.iid,
        from: state.label,
        to: targetState.label,
        reason: "test:skip",
      });

      transitions++;
    }
  }

  return transitions;
}
