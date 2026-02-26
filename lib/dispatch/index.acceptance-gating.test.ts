import { describe, it } from "node:test";
import assert from "node:assert";
import { dispatchTask } from "./index.js";
import { createTestHarness } from "../testing/index.js";

function withAgentStatus(
  base: any,
  status: "accepted" | "deduped" | "rejected" | "unavailable" | "timeout",
) {
  return (async (argv: string[], opts: any) => {
    if (
      argv[0] === "openclaw" &&
      argv[1] === "gateway" &&
      argv[2] === "call" &&
      argv[3] === "agent"
    ) {
      if (status === "timeout")
        throw new Error("gateway timeout while waiting for final event");
      return {
        stdout: JSON.stringify({ status, runId: `run-${status}` }),
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
      };
    }
    return base(argv, opts);
  }) as any;
}

describe("dispatchTask acceptance gating", () => {
  it("keeps issue in To Do and slot inactive when dispatch is deduped", async () => {
    const h = await createTestHarness();
    try {
      h.provider.seedIssue({
        iid: 21,
        title: "Gate dispatch",
        labels: ["To Do"],
      });

      await assert.rejects(
        () =>
          dispatchTask({
            workspaceDir: h.workspaceDir,
            project: h.project,
            issueId: 21,
            issueTitle: "Gate dispatch",
            issueDescription: "",
            issueUrl: "https://example.com/issues/21",
            role: "developer",
            level: "medior",
            fromLabel: "To Do",
            toLabel: "Doing",
            provider: h.provider,
            runCommand: withAgentStatus(h.runCommand, "deduped"),
          }),
        /dispatch deduped/i,
      );

      const issue = await h.provider.getIssue(21);
      assert.ok(issue.labels.includes("To Do"));
      assert.ok(!issue.labels.includes("Doing"));
    } finally {
      await h.cleanup();
    }
  });

  it("increments idempotency nonce across failed attempts", async () => {
    const h = await createTestHarness();
    const seenKeys: string[] = [];
    const rc = (async (argv: string[], opts: any) => {
      if (
        argv[0] === "openclaw" &&
        argv[1] === "gateway" &&
        argv[2] === "call" &&
        argv[3] === "agent"
      ) {
        const params = JSON.parse(argv[argv.indexOf("--params") + 1]!);
        seenKeys.push(params.idempotencyKey);
        return {
          stdout: JSON.stringify({ status: "deduped" }),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }
      return h.runCommand(argv, opts);
    }) as any;

    try {
      h.provider.seedIssue({
        iid: 24,
        title: "nonce retry",
        labels: ["To Do"],
      });
      await assert.rejects(() =>
        dispatchTask({
          workspaceDir: h.workspaceDir,
          project: h.project,
          issueId: 24,
          issueTitle: "nonce retry",
          issueDescription: "",
          issueUrl: "https://example.com/issues/24",
          role: "developer",
          level: "medior",
          fromLabel: "To Do",
          toLabel: "Doing",
          provider: h.provider,
          runCommand: rc,
        }),
      );
      await assert.rejects(() =>
        dispatchTask({
          workspaceDir: h.workspaceDir,
          project: h.project,
          issueId: 24,
          issueTitle: "nonce retry",
          issueDescription: "",
          issueUrl: "https://example.com/issues/24",
          role: "developer",
          level: "medior",
          fromLabel: "To Do",
          toLabel: "Doing",
          provider: h.provider,
          runCommand: rc,
        }),
      );

      assert.strictEqual(seenKeys.length, 2);
      assert.notStrictEqual(seenKeys[0], seenKeys[1]);
    } finally {
      await h.cleanup();
    }
  });

  it("marks slot active when label transition fails after acceptance", async () => {
    const h = await createTestHarness();
    try {
      h.provider.seedIssue({
        iid: 25,
        title: "transition fail",
        labels: ["To Do"],
      });
      const originalTransition = h.provider.transitionLabel.bind(h.provider);
      h.provider.transitionLabel = async (
        issueId: number,
        from: any,
        to: any,
      ) => {
        if (issueId === 25 && from === "To Do" && to === "Doing") {
          throw new Error("provider outage");
        }
        return originalTransition(issueId, from, to);
      };

      await assert.rejects(
        () =>
          dispatchTask({
            workspaceDir: h.workspaceDir,
            project: h.project,
            issueId: 25,
            issueTitle: "transition fail",
            issueDescription: "",
            issueUrl: "https://example.com/issues/25",
            role: "developer",
            level: "medior",
            fromLabel: "To Do",
            toLabel: "Doing",
            provider: h.provider,
            runCommand: withAgentStatus(h.runCommand, "accepted"),
          }),
        /dispatch accepted but failed to transition/i,
      );

      const slot = h.project.workers.developer?.levels.medior?.[0];
      assert.ok(
        slot?.active,
        "slot should be marked active after accepted dispatch",
      );
      assert.strictEqual(slot?.issueId, "25");

      const issue = await h.provider.getIssue(25);
      assert.ok(issue.labels.includes("To Do"));
      assert.ok(!issue.labels.includes("Doing"));
    } finally {
      await h.cleanup();
    }
  });

  for (const status of ["rejected", "unavailable", "timeout"] as const) {
    it(`keeps issue in To Do when dispatch is ${status}`, async () => {
      const h = await createTestHarness();
      try {
        h.provider.seedIssue({
          iid: 22,
          title: `Status ${status}`,
          labels: ["To Do"],
        });

        await assert.rejects(
          () =>
            dispatchTask({
              workspaceDir: h.workspaceDir,
              project: h.project,
              issueId: 22,
              issueTitle: `Status ${status}`,
              issueDescription: "",
              issueUrl: "https://example.com/issues/22",
              role: "developer",
              level: "medior",
              fromLabel: "To Do",
              toLabel: "Doing",
              provider: h.provider,
              runCommand: withAgentStatus(h.runCommand, status),
            }),
          new RegExp(`dispatch ${status}`, "i"),
        );

        const issue = await h.provider.getIssue(22);
        assert.ok(
          issue.labels.includes("To Do"),
          `labels: ${issue.labels.join(",")}`,
        );
        assert.ok(!issue.labels.includes("Doing"));
      } finally {
        await h.cleanup();
      }
    });
  }

  it("transitions to Doing only after accepted response", async () => {
    const h = await createTestHarness();
    try {
      h.provider.seedIssue({
        iid: 23,
        title: "Accepted path",
        labels: ["To Do"],
      });

      const out = await dispatchTask({
        workspaceDir: h.workspaceDir,
        project: h.project,
        issueId: 23,
        issueTitle: "Accepted path",
        issueDescription: "",
        issueUrl: "https://example.com/issues/23",
        role: "developer",
        level: "medior",
        fromLabel: "To Do",
        toLabel: "Doing",
        provider: h.provider,
        runCommand: withAgentStatus(h.runCommand, "accepted"),
      });

      assert.ok(out.sessionKey);
      const issue = await h.provider.getIssue(23);
      assert.ok(issue.labels.includes("Doing"));
      assert.ok(!issue.labels.includes("To Do"));
    } finally {
      await h.cleanup();
    }
  });
});
