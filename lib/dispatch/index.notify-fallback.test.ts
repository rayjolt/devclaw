import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { createTestHarness, type TestHarness } from "../testing/index.js";
import { dispatchTask } from "./index.js";

describe("dispatchTask notification fallback", () => {
  let h: TestHarness;

  afterEach(async () => {
    if (h) await h.cleanup();
  });

  it("uses runCommand notification path when runtime is unavailable", async () => {
    h = await createTestHarness();
    h.provider.seedIssue({
      iid: 19,
      title: "Fallback notify",
      labels: ["To Do"],
    });

    await dispatchTask({
      workspaceDir: h.workspaceDir,
      agentId: "test-agent",
      project: h.project,
      issueId: 19,
      issueTitle: "Fallback notify",
      issueDescription: "",
      issueUrl: "https://github.com/rayjolt/devclaw/issues/19",
      role: "developer",
      level: "senior",
      fromLabel: "To Do",
      toLabel: "Doing",
      provider: h.provider,
      runCommand: h.runCommand,
    });

    const notifyCommands = h.commands.commands.filter(
      (c) =>
        c.argv[0] === "openclaw" &&
        c.argv[1] === "message" &&
        c.argv[2] === "send",
    );

    assert.ok(
      notifyCommands.length >= 1,
      "Expected openclaw message send fallback command",
    );
  });
});
