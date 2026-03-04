/**
 * runtime/workspace-resolution.ts — Canonical DevClaw runtime workspace resolver.
 *
 * Goal: prevent DevClaw runtime from "drifting" into other OpenClaw workspaces.
 * Runtime must resolve a single authoritative workspace binding and fail closed
 * if it cannot.
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export type WorkspaceResolutionSource = "binding" | "legacy" | "error";

export type WorkspaceResolutionOk = {
  ok: true;
  agentId: string;
  workspaceDir: string;
  source: Exclude<WorkspaceResolutionSource, "error">;
};

export type WorkspaceResolutionErr = {
  ok: false;
  agentId: null;
  workspaceDir: null;
  source: "error";
  error: string;
};

export type WorkspaceResolutionResult = WorkspaceResolutionOk | WorkspaceResolutionErr;

export type OpenClawConfigLike = {
  agents?: {
    list?: Array<{ id: string; workspace?: string }>;
    defaults?: { workspace?: string };
  };
};

export type DevClawPluginConfigLike = {
  /** Preferred: written by DevClaw setup into openclaw.json plugin config. */
  runtimeWorkspace?: {
    agentId?: string;
    workspaceDir?: string;
  };
};

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

function normalizeWorkspaceDir(p: string): string {
  // Expand ~ then resolve to an absolute path.
  const expanded = expandHome(p.trim());
  return path.resolve(expanded);
}

function isExistingDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function err(message: string): WorkspaceResolutionErr {
  return {
    ok: false,
    agentId: null,
    workspaceDir: null,
    source: "error",
    error: message,
  };
}

/**
 * Resolve DevClaw runtime workspace binding.
 *
 * Resolution order:
 *  1) Plugin config binding: pluginConfig.runtimeWorkspace { agentId, workspaceDir }
 *  2) Legacy fallback: agents.list entry for id === "devclaw" (explicit agent workspace)
 *
 * Explicitly NOT allowed:
 *  - agents.defaults.workspace
 *  - hardcoded ~/.openclaw/workspace-devclaw fallbacks
 */
export function resolveRuntimeWorkspace(opts: {
  pluginConfig?: Record<string, unknown> | undefined;
  config?: OpenClawConfigLike | undefined;
  /** If true (default), workspaceDir must exist as a directory. */
  requireExists?: boolean;
}): WorkspaceResolutionResult {
  const requireExists = opts.requireExists ?? true;
  const pluginCfg = (opts.pluginConfig ?? {}) as DevClawPluginConfigLike;
  const fullCfg = (opts.config ?? {}) as OpenClawConfigLike;

  // 1) Authoritative binding (preferred)
  const binding = pluginCfg.runtimeWorkspace;
  if (binding && (binding.agentId || binding.workspaceDir)) {
    const agentId = String(binding.agentId ?? "").trim();
    const rawWs = String(binding.workspaceDir ?? "").trim();
    if (!agentId) return err("DevClaw runtime workspace binding is missing agentId (plugins.entries.devclaw.config.runtimeWorkspace.agentId)");
    if (!rawWs) return err("DevClaw runtime workspace binding is missing workspaceDir (plugins.entries.devclaw.config.runtimeWorkspace.workspaceDir)");

    const workspaceDir = normalizeWorkspaceDir(rawWs);

    if (requireExists && !isExistingDirectory(workspaceDir)) {
      return err(
        `DevClaw runtime workspace directory does not exist: ${workspaceDir}. Re-run DevClaw setup for agent "${agentId}".`,
      );
    }

    // Cross-check against agent list if present — prevents stale/mismatched binding.
    const agentEntry = fullCfg.agents?.list?.find((a) => a.id === agentId);
    if (agentEntry?.workspace) {
      const agentWorkspace = normalizeWorkspaceDir(agentEntry.workspace);
      if (agentWorkspace !== workspaceDir) {
        return err(
          `DevClaw runtime workspace binding mismatch for agent "${agentId}": pluginConfig=${workspaceDir} but agents.list=${agentWorkspace}`,
        );
      }
    }

    return { ok: true, agentId, workspaceDir, source: "binding" };
  }

  // 2) Legacy: explicit devclaw agent workspace in agents.list
  const legacy = fullCfg.agents?.list?.find((a) => a.id === "devclaw");
  if (legacy?.workspace) {
    const workspaceDir = normalizeWorkspaceDir(legacy.workspace);
    if (requireExists && !isExistingDirectory(workspaceDir)) {
      return err(
        `Legacy DevClaw agent workspace does not exist: ${workspaceDir}. Re-run DevClaw setup to write an explicit runtimeWorkspace binding.`,
      );
    }
    return { ok: true, agentId: legacy.id, workspaceDir, source: "legacy" };
  }

  return err(
    "DevClaw runtime workspace binding could not be resolved. Run the DevClaw setup tool to bind runtimeWorkspace (agentId + workspaceDir).",
  );
}
