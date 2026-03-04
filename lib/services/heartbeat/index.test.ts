import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverAgents } from "./agent-discovery.js";
import {
  refreshWorkspaceScaffolding,
  resetRefreshedWorkspacesForTests,
} from "./index.js";

afterEach(() => {
  resetRefreshedWorkspacesForTests();
});

describe("heartbeat workspace refresh cadence", () => {
  it("refreshes each workspace at most once across multiple ticks", async () => {
    const calls: string[] = [];
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    const agents = [
      { agentId: "devclaw", workspace: "/tmp/ws-a" },
      { agentId: "devclaw-2", workspace: "/tmp/ws-a" },
    ];

    await refreshWorkspaceScaffolding(agents, logger, async (workspaceDir) => {
      calls.push(workspaceDir);
    });
    await refreshWorkspaceScaffolding(agents, logger, async (workspaceDir) => {
      calls.push(workspaceDir);
    });

    assert.deepEqual(calls, ["/tmp/ws-a"]);
  });

  it("does not refresh agents.defaults.workspace when runtime binding resolves elsewhere", async () => {
    const boundWs = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-bound-refresh-"));
    const defaultWs = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-default-refresh-"));

    // Marker path that previously caused confusion when defaults workspace was scanned.
    await fs.mkdir(path.join(defaultWs, "devclaw"), { recursive: true });
    await fs.writeFile(
      path.join(defaultWs, "devclaw", "projects.json"),
      JSON.stringify({ marker: true }),
      "utf-8",
    );

    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
    };

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

      const calls: string[] = [];
      await refreshWorkspaceScaffolding(agents, logger, async (workspaceDir) => {
        calls.push(workspaceDir);
      });

      assert.deepEqual(calls, [boundWs]);
      assert.equal(calls.includes(defaultWs), false);
    } finally {
      await Promise.all([
        fs.rm(boundWs, { recursive: true, force: true }),
        fs.rm(defaultWs, { recursive: true, force: true }),
      ]);
    }
  });
});
