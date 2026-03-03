/**
 * tasks_status — Live issue counts and details from the issue tracker.
 *
 * Fetches all non-terminal issues grouped by state type (hold, active, queue).
 * Use `project_status` for instant local info, this tool for live issue data.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../../types.js";
import type { PluginContext } from "../../context.js";
import { log as auditLog } from "../../audit.js";
import { getStateLabelsByType } from "../../services/queue.js";
import { requireWorkspaceDir, resolveChannelId, resolveProject, resolveProvider } from "../helpers.js";
import { loadConfig } from "../../config/index.js";
import { ciDiagnostics, getCiStatusWithRetry } from "../../services/ci-gate.js";
import { CiState, type IssueProvider } from "../../providers/provider.js";
import { getDependencyGateStatus } from "../../services/queue-scan.js";

type IssueSummary = {
  id: number;
  title: string;
  url: string;
  ciState?: string;
  ciReason?: string;
  ciFailedChecks?: string[];
  ciPendingChecks?: string[];
  dependencyBlocked?: boolean;
  dependencyBlockKind?: "dependency" | "cycle" | "uncertain";
  dependencyReason?: string;
  dependencyCyclePath?: number[];
};

async function withCiSummary(provider: IssueProvider, issue: { iid: number; title: string; web_url: string }, enabled: boolean): Promise<IssueSummary> {
  const base: IssueSummary = { id: issue.iid, title: issue.title, url: issue.web_url };
  if (!enabled) return base;

  const { status: ci } = await getCiStatusWithRetry(provider, issue.iid, 3);
  if (ci.state === CiState.PASS) return { ...base, ciState: ci.state };

  return {
    ...base,
    ciState: ci.state,
    ciReason: ciDiagnostics(ci),
    ciFailedChecks: ci.failedChecks,
    ciPendingChecks: ci.pendingChecks,
  };
}

export function createTasksStatusTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "tasks_status",
    label: "Tasks Status",
    description:
      "Live issue dashboard from the issue tracker: issues waiting for input (hold), " +
      "work in progress (active), and queued for work (queue) — with issue details. " +
      "Use `project_status` for instant local info, `task_list` to filter/search issues.",
    parameters: {
      type: "object",
      required: ["channelId"],
      properties: {
        channelId: {
          type: "string",
          description: "YOUR chat/group ID — the numeric ID of the chat you are in right now (e.g. '-1003844794417'). Do NOT guess; use the ID of the conversation this message came from.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(toolCtx);
      const channelId = resolveChannelId(toolCtx, params.channelId as string | undefined);

      const { project } = await resolveProject(workspaceDir, channelId);
      const { provider } = await resolveProvider(project, ctx.runCommand);

      const projectConfig = await loadConfig(workspaceDir, project.name);
      const workflow = projectConfig.workflow;
      const statesByType = getStateLabelsByType(workflow);

      // Fetch issues for each state type
      const hold: Record<string, { count: number; issues: IssueSummary[] }> = {};
      for (const { label } of statesByType.hold) {
        const issues = await provider.listIssues({ label, state: "open" }).catch(() => []);
        hold[label] = {
          count: issues.length,
          issues: issues.map((i) => ({ id: i.iid, title: i.title, url: i.web_url })),
        };
      }

      const active: Record<string, { count: number; issues: IssueSummary[] }> = {};
      for (const { label } of statesByType.active) {
        const issues = await provider.listIssues({ label, state: "open" }).catch(() => []);
        const summaries: IssueSummary[] = [];
        for (const i of issues) summaries.push(await withCiSummary(provider, i, !!workflow.ciGating));
        active[label] = {
          count: issues.length,
          issues: summaries,
        };
      }

      const queue: Record<string, { count: number; issues: IssueSummary[] }> = {};
      for (const { label } of statesByType.queue) {
        const issues = await provider.listIssues({ label, state: "open" }).catch(() => []);
        const summaries: IssueSummary[] = [];
        for (const i of issues) {
          const summary = await withCiSummary(provider, i, !!workflow.ciGating);
          const dep = await getDependencyGateStatus(provider, { iid: i.iid }, workflow);
          summaries.push({
            ...summary,
            dependencyBlocked: dep.blocked,
            dependencyBlockKind: dep.kind,
            dependencyReason: dep.reason,
            dependencyCyclePath: dep.cyclePath,
          });
        }
        queue[label] = {
          count: issues.length,
          issues: summaries,
        };
      }

      // Totals
      const totalHold = Object.values(hold).reduce((s, c) => s + c.count, 0);
      const totalActive = Object.values(active).reduce((s, c) => s + c.count, 0);
      const totalQueued = Object.values(queue).reduce((s, c) => s + c.count, 0);

      await auditLog(workspaceDir, "tasks_status", {
        project: project.name,
        totalHold,
        totalActive,
        totalQueued,
      });

      // State labels for context
      const stateLabels = {
        hold: statesByType.hold.map((s) => ({ label: s.label, hint: "waiting for input" })),
        active: statesByType.active.map((s) => ({ label: s.label, role: s.role })),
        queue: statesByType.queue.map((s) => ({ label: s.label, role: s.role, priority: s.priority })),
      };

      return jsonResult({
        success: true,
        project: project.name,
        stateLabels,
        summary: { totalHold, totalActive, totalQueued },
        hold,
        active,
        queue,
      });
    },
  });
}
