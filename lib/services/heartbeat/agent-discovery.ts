/**
 * Agent discovery — resolve the single authoritative DevClaw runtime workspace.
 *
 * DevClaw runtime must NOT scan arbitrary workspaces, must NOT fall back to
 * agents.defaults.workspace, and must NOT infer a workspace from "devclaw markers".
 */
import { resolveRuntimeWorkspace, type WorkspaceResolutionResult } from "../../runtime/workspace-resolution.js";

export type Agent = {
  agentId: string;
  workspace: string;
};

/**
 * Discover DevClaw runtime agent(s).
 *
 * Returns at most one agent: the bound DevClaw runtime workspace.
 */
export function discoverAgents(
  config: any,
  pluginConfig?: Record<string, unknown>,
): { agents: Agent[]; resolution: WorkspaceResolutionResult } {
  const resolution = resolveRuntimeWorkspace({
    config: config as any,
    pluginConfig,
    requireExists: true,
  });

  if (!resolution.ok) {
    return { agents: [], resolution };
  }

  return {
    agents: [{ agentId: resolution.agentId, workspace: resolution.workspaceDir }],
    resolution,
  };
}
