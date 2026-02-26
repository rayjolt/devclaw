import { describe, it } from "node:test";
import assert from "node:assert";
import { sendToAgent } from "./session.js";

function mkRunCommand(stdout: string): any {
  return async () => ({
    stdout,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: { type: "exit", code: 0 },
  });
}

describe("sendToAgent acceptance parsing", () => {
  it("accepts early-ack gateway response shape", async () => {
    const out = await sendToAgent("agent:test:subagent:proj-dev", "msg", {
      projectName: "proj",
      issueId: 25,
      role: "developer",
      level: "medior",
      workspaceDir: "/tmp",
      runCommand: mkRunCommand('{"status":"accepted","runId":"run-early"}'),
    });

    assert.strictEqual(out.accepted, true);
    assert.strictEqual(out.status, "accepted");
    assert.strictEqual(out.runId, "run-early");
    assert.strictEqual(out.mode, "early-status");
  });

  it("accepts --expect-final response shape (status ok + runId + result)", async () => {
    const out = await sendToAgent("agent:test:subagent:proj-dev", "msg", {
      projectName: "proj",
      issueId: 25,
      role: "developer",
      level: "medior",
      workspaceDir: "/tmp",
      runCommand: mkRunCommand(
        '{"status":"ok","runId":"run-final","result":{"summary":"completed","output":"done"}}',
      ),
    });

    assert.strictEqual(out.accepted, true);
    assert.strictEqual(out.status, "accepted");
    assert.strictEqual(out.runId, "run-final");
    assert.strictEqual(out.mode, "final-ok");
  });

  it("does not treat final envelope as accepted when nested status is rejected", async () => {
    const out = await sendToAgent("agent:test:subagent:proj-dev", "msg", {
      projectName: "proj",
      issueId: 25,
      role: "developer",
      level: "medior",
      workspaceDir: "/tmp",
      runCommand: mkRunCommand(
        '{"status":"ok","runId":"run-final","result":{"status":"rejected","reason":"duplicate"}}',
      ),
    });

    assert.strictEqual(out.accepted, false);
    assert.strictEqual(out.status, "rejected");
    assert.strictEqual(out.runId, "run-final");
    assert.strictEqual(out.reason, "duplicate");
    assert.strictEqual(out.mode, "explicit-failure");
  });

  it("does not treat final envelope as accepted when nested accepted=false", async () => {
    const out = await sendToAgent("agent:test:subagent:proj-dev", "msg", {
      projectName: "proj",
      issueId: 25,
      role: "developer",
      level: "medior",
      workspaceDir: "/tmp",
      runCommand: mkRunCommand(
        '{"status":"ok","runId":"run-final","result":{"accepted":false,"reason":"deduped"}}',
      ),
    });

    assert.strictEqual(out.accepted, false);
    assert.strictEqual(out.status, "rejected");
    assert.strictEqual(out.runId, "run-final");
    assert.strictEqual(out.reason, "deduped");
    assert.strictEqual(out.mode, "accepted-flag");
  });

  it("fails closed for malformed final-mode responses", async () => {
    const out = await sendToAgent("agent:test:subagent:proj-dev", "msg", {
      projectName: "proj",
      issueId: 25,
      role: "developer",
      level: "medior",
      workspaceDir: "/tmp",
      runCommand: mkRunCommand('{"status":"ok","runId":"run-final"}'),
    });

    assert.strictEqual(out.accepted, false);
    assert.strictEqual(out.status, "failed");
    assert.match(String(out.reason), /did not include acceptance status/i);
    assert.strictEqual(out.mode, "invalid");
  });
});
