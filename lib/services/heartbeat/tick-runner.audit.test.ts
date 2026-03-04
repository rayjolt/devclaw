import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { tick } from "./tick-runner.js";

const noopRunCommand = (async () => ({
  stdout: "{}",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
})) as any;

describe("heartbeat tick audit payload", () => {
  it("includes resolved workspace fields in heartbeat_tick audit event", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-tick-audit-"));
    try {
      await tick({
        workspaceDir: ws,
        agentId: "devclaw",
        resolvedWorkspaceDir: ws,
        resolvedAgentId: "devclaw",
        resolutionSource: "binding",
        config: { intervalSeconds: 60, enabled: true, maxPickupsPerTick: 1 } as any,
        pluginConfig: {},
        sessions: null,
        logger: { info() {}, warn() {} },
        runtime: undefined,
        runCommand: noopRunCommand,
      });

      const auditPath = path.join(ws, "devclaw", "log", "audit.log");
      const raw = await fs.readFile(auditPath, "utf-8");
      const lines = raw.trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]);

      assert.equal(last.event, "heartbeat_tick");
      assert.equal(last.resolvedWorkspaceDir, ws);
      assert.equal(last.resolvedAgentId, "devclaw");
      assert.equal(last.resolutionSource, "binding");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});
