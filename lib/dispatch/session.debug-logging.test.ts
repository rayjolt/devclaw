import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sendToAgent } from "./session.js";

describe("sendToAgent debug envelope logging", () => {
  it("logs request/response envelopes with field-level truncation markers", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "devclaw-session-debug-"),
    );
    try {
      const longMessage = "m".repeat(2_800);
      const longPrompt = "p".repeat(2_700);
      const longOutput = "o".repeat(5_200);
      const longRunId = "run-" + "r".repeat(5_100);
      const responseItems = Array.from({ length: 30 }, (_, i) => `item-${i}`);

      const runCommand: any = async () => ({
        stdout: JSON.stringify({
          status: "ok",
          runId: longRunId,
          result: {
            output: longOutput,
            items: responseItems,
          },
        }),
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: { type: "exit", code: 0 },
      });

      const out = await sendToAgent(
        "agent:test:subagent:proj-dev-senior",
        longMessage,
        {
          projectName: "proj",
          issueId: 70,
          role: "developer",
          level: "senior",
          slotIndex: 0,
          dispatchAttempt: 1,
          workspaceDir,
          extraSystemPrompt: longPrompt,
          runCommand,
        },
      );

      assert.equal(out.accepted, true);
      assert.equal(out.status, "accepted");
      assert.equal(out.mode, "final-ok");
      assert.equal(out.runId, longRunId);

      const auditPath = path.join(workspaceDir, "devclaw", "log", "audit.log");
      const raw = await fs.readFile(auditPath, "utf-8");
      const events = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      const reqEvent = events.find(
        (e) => e.event === "dispatch_debug" && e.step === "sendToAgent.request",
      );
      const resEvent = events.find(
        (e) =>
          e.event === "dispatch_debug" && e.step === "sendToAgent.response",
      );

      assert.ok(reqEvent, "request debug event should exist");
      assert.ok(resEvent, "response debug event should exist");

      assert.equal(reqEvent.envelope.agentId, "devclaw");
      assert.equal(
        reqEvent.envelope.sessionKey,
        "agent:test:subagent:proj-dev-senior",
      );
      assert.equal(reqEvent.envelope.lane, "subagent");
      assert.match(
        String(reqEvent.envelope.message),
        /\[truncated originalLength=2800 keptLength=2000\]$/,
      );
      assert.match(
        String(reqEvent.envelope.extraSystemPrompt),
        /\[truncated originalLength=2700 keptLength=2000\]$/,
      );

      assert.equal(resEvent.status, "accepted");
      assert.equal(resEvent.runId, longRunId);
      assert.equal(resEvent.mode, "final-ok");
      assert.equal(resEvent.envelope.status, "ok");
      assert.equal(resEvent.envelope.runId, longRunId);
      assert.match(
        String(resEvent.envelope.result.output),
        /\[truncated originalLength=5200 keptLength=4000\]$/,
      );
      assert.equal(resEvent.envelope.result.items.length, 21);
      assert.deepEqual(resEvent.envelope.result.items[20], {
        __truncated: true,
        kind: "array",
        originalLength: 30,
        keptLength: 20,
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
