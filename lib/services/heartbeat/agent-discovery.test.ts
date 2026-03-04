import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverAgents } from "./agent-discovery.js";

describe("heartbeat agent discovery", () => {
  it("returns only the bound workspace (does not scan defaults workspace)", async () => {
    const boundWs = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-bound-ws-"));
    const defaultWs = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-default-ws-"));

    try {
      const { agents, resolution } = discoverAgents(
        {
          agents: {
            list: [{ id: "devclaw", workspace: boundWs }],
            defaults: { workspace: defaultWs },
          },
        } as any,
        {
          runtimeWorkspace: { agentId: "devclaw", workspaceDir: boundWs },
        },
      );

      assert.equal(resolution.ok, true);
      assert.equal(agents.length, 1);
      assert.equal(agents[0].workspace, boundWs);
    } finally {
      await Promise.all([
        fs.rm(boundWs, { recursive: true, force: true }),
        fs.rm(defaultWs, { recursive: true, force: true }),
      ]);
    }
  });

  it("fails closed when no binding is resolvable (even if defaults is set)", async () => {
    const defaultWs = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-default-ws-only-"));

    try {
      const { agents, resolution } = discoverAgents(
        {
          agents: {
            list: [],
            defaults: { workspace: defaultWs },
          },
        } as any,
        {},
      );

      assert.equal(agents.length, 0);
      assert.equal(resolution.ok, false);
      if (resolution.ok) return;
      assert.match(resolution.error, /could not be resolved/i);
    } finally {
      await fs.rm(defaultWs, { recursive: true, force: true });
    }
  });
});
