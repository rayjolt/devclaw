import { describe, it } from "node:test";
import assert from "node:assert";
import { sendToAgent } from "./session.js";

describe("sendToAgent idempotency key", () => {
  it("includes dispatchAttempt nonce, differs across redispatch attempts, excludes model from payload, and sets gateway timeout flag", async () => {
    const captured: string[] = [];
    const rawParams: Array<Record<string, unknown>> = [];
    const argvCalls: string[][] = [];
    const callTimeouts: number[] = [];

    const runCommand: any = async (argv: string[], opts: any) => {
      const paramsIdx = argv.indexOf("--params");
      if (
        argv[0] === "openclaw" &&
        argv[1] === "gateway" &&
        argv[2] === "call" &&
        argv[3] === "agent" &&
        paramsIdx >= 0
      ) {
        argvCalls.push(argv);
        callTimeouts.push(opts?.timeoutMs);
        const params = JSON.parse(argv[paramsIdx + 1]!);
        rawParams.push(params);
        captured.push(params.idempotencyKey);
      }
      return {
        stdout: '{"status":"accepted","runId":"run-test"}',
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: { type: "exit", code: 0 },
      };
    };

    await sendToAgent("agent:test:subagent:proj-dev-senior-ada", "msg", {
      projectName: "proj",
      issueId: 17,
      role: "developer",
      level: "senior",
      slotIndex: 0,
      dispatchAttempt: 1,
      workspaceDir: "/tmp",
      model: "openai/gpt-5",
      runCommand,
    });

    await sendToAgent("agent:test:subagent:proj-dev-senior-ada", "msg", {
      projectName: "proj",
      issueId: 17,
      role: "developer",
      level: "senior",
      slotIndex: 0,
      dispatchAttempt: 2,
      workspaceDir: "/tmp",
      model: "openai/gpt-5",
      runCommand,
    });

    await new Promise((r) => setTimeout(r, 0));

    assert.strictEqual(captured.length, 2);
    assert.ok(
      captured[0]!.includes("-0-1-agent:test:subagent:proj-dev-senior-ada"),
    );
    assert.ok(
      captured[1]!.includes("-0-2-agent:test:subagent:proj-dev-senior-ada"),
    );
    assert.notStrictEqual(captured[0], captured[1]);
    assert.ok(rawParams.every((params) => !("model" in params)));
    assert.strictEqual(argvCalls.length, 2);
    for (const argv of argvCalls) {
      const timeoutIdx = argv.indexOf("--timeout");
      assert.ok(timeoutIdx >= 0, "expected --timeout flag in gateway call");
      assert.strictEqual(argv[timeoutIdx + 1], "30000");
    }
    assert.ok(
      callTimeouts.every((timeoutMs) => Number(timeoutMs) > 30_000),
      "runCommand timeout should remain above gateway timeout",
    );
  });
});
