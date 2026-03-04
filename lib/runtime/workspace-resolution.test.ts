import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeWorkspace } from "./workspace-resolution.js";

describe("runtime workspace resolution", () => {
  it("prefers explicit plugin config runtimeWorkspace binding", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-ws-binding-"));
    try {
      const res = resolveRuntimeWorkspace({
        pluginConfig: {
          runtimeWorkspace: { agentId: "devclaw", workspaceDir: ws },
        },
        config: {
          agents: { list: [{ id: "devclaw", workspace: ws }] },
        },
        requireExists: true,
      });

      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.source, "binding");
      assert.equal(res.agentId, "devclaw");
      assert.equal(res.workspaceDir, ws);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("falls back to legacy agents.list devclaw workspace (but never defaults)", async () => {
    const legacyWs = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-ws-legacy-"));
    const defaultWs = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-ws-default-"));
    try {
      const res = resolveRuntimeWorkspace({
        pluginConfig: {},
        config: {
          agents: {
            list: [{ id: "devclaw", workspace: legacyWs }],
            defaults: { workspace: defaultWs },
          },
        },
        requireExists: true,
      });

      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.source, "legacy");
      assert.equal(res.workspaceDir, legacyWs);
    } finally {
      await Promise.all([
        fs.rm(legacyWs, { recursive: true, force: true }),
        fs.rm(defaultWs, { recursive: true, force: true }),
      ]);
    }
  });

  it("fails closed when no binding is present (even if defaults workspace is set)", async () => {
    const defaultWs = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-ws-default-only-"));
    try {
      const res = resolveRuntimeWorkspace({
        pluginConfig: {},
        config: {
          agents: {
            list: [],
            defaults: { workspace: defaultWs },
          },
        },
        requireExists: true,
      });

      assert.equal(res.ok, false);
      if (res.ok) return;
      assert.equal(res.source, "error");
      assert.match(res.error, /could not be resolved/i);
    } finally {
      await fs.rm(defaultWs, { recursive: true, force: true });
    }
  });

  it("fails closed when binding workspaceDir does not exist", () => {
    const missing = path.join(os.tmpdir(), `devclaw-missing-${Date.now()}`);
    const res = resolveRuntimeWorkspace({
      pluginConfig: {
        runtimeWorkspace: { agentId: "devclaw", workspaceDir: missing },
      },
      config: {
        agents: { list: [{ id: "devclaw", workspace: missing }] },
      },
      requireExists: true,
    });

    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /does not exist/i);
  });
});
