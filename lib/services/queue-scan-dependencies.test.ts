import { describe, it } from "node:test";
import assert from "node:assert";
import { findNextIssueForRole, getDependencyGateStatus } from "./queue-scan.js";
import { DEFAULT_WORKFLOW } from "../workflow/index.js";
import type {
  Issue,
  IssueDependencies,
  IssueProvider,
} from "../providers/provider.js";

type QueueProvider = Pick<
  IssueProvider,
  "listIssuesByLabel" | "getIssueDependencies"
>;

function issue(iid: number, labels: string[] = ["To Do"]): Issue {
  return {
    iid,
    title: `Issue #${iid}`,
    description: "",
    labels,
    state: "OPEN",
    web_url: `https://example.test/issues/${iid}`,
  };
}

describe("findNextIssueForRole dependency gating", () => {
  it("dispatches issues with no dependencies", async () => {
    const provider: QueueProvider = {
      async listIssuesByLabel() {
        return [issue(100)];
      },
      async getIssueDependencies(issueId: number): Promise<IssueDependencies> {
        return { issueId, blockers: [], dependents: [] };
      },
    };

    const next = await findNextIssueForRole(
      provider,
      "developer",
      DEFAULT_WORKFLOW,
    );
    assert.ok(next);
    assert.strictEqual(next!.issue.iid, 100);
  });

  it("skips blocked issues and dispatches the next unblocked issue", async () => {
    const provider: QueueProvider = {
      async listIssuesByLabel() {
        return [issue(1), issue(2)];
      },
      async getIssueDependencies(issueId: number): Promise<IssueDependencies> {
        if (issueId === 2) {
          return {
            issueId,
            blockers: [
              {
                iid: 10,
                title: "blocker",
                state: "OPEN",
                web_url: "u",
                relation: "blocked_by",
              },
            ],
            dependents: [],
          };
        }
        return { issueId, blockers: [], dependents: [] };
      },
    };

    const next = await findNextIssueForRole(
      provider,
      "developer",
      DEFAULT_WORKFLOW,
    );
    assert.ok(next);
    assert.strictEqual(next!.issue.iid, 1);
  });

  it("continues scanning after a dependency-blocked head-of-queue issue (no head-of-line blocking)", async () => {
    // Simulate provider returning newest-first, so reverse() yields FIFO scan.
    // We want the scan order to be: 66 (blocked) → 65 (eligible).
    const provider: QueueProvider = {
      async listIssuesByLabel() {
        return [issue(65), issue(66)];
      },
      async getIssueDependencies(issueId: number): Promise<IssueDependencies> {
        if (issueId === 66) {
          return {
            issueId,
            blockers: [
              {
                iid: 65,
                title: "blocker",
                state: "OPEN",
                web_url: "u",
                relation: "blocked_by",
              },
            ],
            dependents: [],
          };
        }
        return { issueId, blockers: [], dependents: [] };
      },
    };

    const blocked: Array<{ iid: number; reason?: string }> = [];
    const next = await findNextIssueForRole(
      provider,
      "developer",
      DEFAULT_WORKFLOW,
      undefined,
      {
        onDependencyBlocked: async ({ issue, gate }) => {
          blocked.push({ iid: issue.iid, reason: gate.reason });
        },
      },
    );

    assert.ok(next);
    assert.strictEqual(next!.issue.iid, 65);
    assert.deepStrictEqual(
      blocked.map((b) => b.iid),
      [66],
    );
  });

  it("treats rejected blockers as still blocking", async () => {
    const provider: QueueProvider = {
      async listIssuesByLabel() {
        return [issue(1), issue(2)];
      },
      async getIssueDependencies(issueId: number): Promise<IssueDependencies> {
        if (issueId === 2) {
          return {
            issueId,
            blockers: [
              {
                iid: 11,
                title: "rejected blocker",
                state: "CLOSED",
                web_url: "u",
                labels: ["Rejected"],
                relation: "blocked_by",
              },
            ],
            dependents: [],
          };
        }
        return { issueId, blockers: [], dependents: [] };
      },
    };

    const next = await findNextIssueForRole(
      provider,
      "developer",
      DEFAULT_WORKFLOW,
    );
    assert.ok(next);
    assert.strictEqual(next!.issue.iid, 1);
  });

  it("allows dispatch when all blockers are terminal non-rejected", async () => {
    const provider: QueueProvider = {
      async listIssuesByLabel() {
        return [issue(5)];
      },
      async getIssueDependencies(issueId: number): Promise<IssueDependencies> {
        return {
          issueId,
          blockers: [
            {
              iid: 20,
              title: "done blocker",
              state: "CLOSED",
              web_url: "u",
              labels: ["Done"],
              relation: "blocked_by",
            },
            {
              iid: 21,
              title: "closed blocker",
              state: "CLOSED",
              web_url: "u",
              relation: "blocked_by",
            },
          ],
          dependents: [],
        };
      },
    };

    const next = await findNextIssueForRole(
      provider,
      "developer",
      DEFAULT_WORKFLOW,
    );
    assert.ok(next);
    assert.strictEqual(next!.issue.iid, 5);
  });

  it("retries dependency reads and fails closed if still uncertain", async () => {
    let attempts = 0;
    const provider: QueueProvider = {
      async listIssuesByLabel(label: string) {
        return label === "To Do" ? [issue(9)] : [];
      },
      async getIssueDependencies() {
        attempts++;
        throw new Error("transient provider failure");
      },
    };

    const next = await findNextIssueForRole(
      provider,
      "developer",
      DEFAULT_WORKFLOW,
    );
    assert.strictEqual(next, null);
    assert.strictEqual(attempts, 3);
  });

  it("retries dependency reads and succeeds on a later attempt", async () => {
    let attempts = 0;
    const provider: QueueProvider = {
      async listIssuesByLabel() {
        return [issue(12)];
      },
      async getIssueDependencies(issueId: number) {
        attempts++;
        if (attempts < 3) throw new Error("temporary");
        return { issueId, blockers: [], dependents: [] };
      },
    };

    const next = await findNextIssueForRole(
      provider,
      "developer",
      DEFAULT_WORKFLOW,
    );
    assert.ok(next);
    assert.strictEqual(next!.issue.iid, 12);
    assert.strictEqual(attempts, 3);
  });

  it("detects direct dependency cycle A↔B", async () => {
    const provider: QueueProvider = {
      async listIssuesByLabel() {
        return [issue(1)];
      },
      async getIssueDependencies(issueId: number): Promise<IssueDependencies> {
        if (issueId === 1) {
          return {
            issueId,
            blockers: [
              {
                iid: 2,
                title: "B",
                state: "OPEN",
                web_url: "u",
                relation: "blocked_by",
              },
            ],
            dependents: [],
          };
        }
        return {
          issueId,
          blockers: [
            {
              iid: 1,
              title: "A",
              state: "OPEN",
              web_url: "u",
              relation: "blocked_by",
            },
          ],
          dependents: [],
        };
      },
    };

    const gate = await getDependencyGateStatus(
      provider,
      { iid: 1 },
      DEFAULT_WORKFLOW,
    );
    assert.strictEqual(gate.blocked, true);
    assert.strictEqual(gate.kind, "cycle");
    assert.deepStrictEqual(gate.cyclePath, [1, 2, 1]);
  });

  it("detects indirect dependency cycle A→B→C→A and invokes cycle callback", async () => {
    const provider: QueueProvider = {
      async listIssuesByLabel() {
        return [issue(1)];
      },
      async getIssueDependencies(issueId: number): Promise<IssueDependencies> {
        if (issueId === 1) {
          return {
            issueId,
            blockers: [
              {
                iid: 2,
                title: "B",
                state: "OPEN",
                web_url: "u",
                relation: "blocked_by",
              },
            ],
            dependents: [],
          };
        }
        if (issueId === 2) {
          return {
            issueId,
            blockers: [
              {
                iid: 3,
                title: "C",
                state: "OPEN",
                web_url: "u",
                relation: "blocked_by",
              },
            ],
            dependents: [],
          };
        }
        return {
          issueId,
          blockers: [
            {
              iid: 1,
              title: "A",
              state: "OPEN",
              web_url: "u",
              relation: "blocked_by",
            },
          ],
          dependents: [],
        };
      },
    };

    let callbackPath: number[] | null = null;
    const next = await findNextIssueForRole(
      provider,
      "developer",
      DEFAULT_WORKFLOW,
      undefined,
      {
        onCycleDetected: async ({ cyclePath }) => {
          callbackPath = cyclePath;
        },
      },
    );

    assert.strictEqual(next, null);
    assert.deepStrictEqual(callbackPath, [1, 2, 3, 1]);
  });

  it("transitions cycle issues to Refining via onCycleDetected hook (integration wiring)", async () => {
    const transitions: Array<{ issueId: number; from: string; to: string }> =
      [];

    const provider: QueueProvider & Pick<IssueProvider, "transitionLabel"> = {
      async listIssuesByLabel(label: string) {
        return label === "To Do" ? [issue(1)] : [];
      },
      async getIssueDependencies(issueId: number): Promise<IssueDependencies> {
        if (issueId === 1) {
          return {
            issueId,
            blockers: [
              {
                iid: 2,
                title: "B",
                state: "OPEN",
                web_url: "u",
                relation: "blocked_by",
              },
            ],
            dependents: [],
          };
        }
        return {
          issueId,
          blockers: [
            {
              iid: 1,
              title: "A",
              state: "OPEN",
              web_url: "u",
              relation: "blocked_by",
            },
          ],
          dependents: [],
        };
      },
      async transitionLabel(
        issueId: number,
        from: string,
        to: string,
      ): Promise<void> {
        transitions.push({ issueId, from, to });
      },
    };

    const next = await findNextIssueForRole(
      provider,
      "developer",
      DEFAULT_WORKFLOW,
      undefined,
      {
        onCycleDetected: async ({ issue, label }) => {
          await provider.transitionLabel(issue.iid, label, "Refining");
        },
      },
    );

    assert.strictEqual(next, null);
    assert.deepStrictEqual(transitions, [
      { issueId: 1, from: "To Do", to: "Refining" },
    ]);
  });

  it("continues scanning when isEligible throws for one issue", async () => {
    const provider: QueueProvider = {
      async listIssuesByLabel() {
        return [issue(1), issue(2)];
      },
      async getIssueDependencies(issueId: number): Promise<IssueDependencies> {
        return { issueId, blockers: [], dependents: [] };
      },
    };

    const next = await findNextIssueForRole(
      provider,
      "developer",
      DEFAULT_WORKFLOW,
      undefined,
      {
        isEligible: ({ issue }) => {
          if (issue.iid === 2) throw new Error("boom");
          return true;
        },
      },
    );

    assert.ok(next);
    assert.strictEqual(next!.issue.iid, 1);
  });

  it("continues scanning when onIneligible throws for one issue", async () => {
    const provider: QueueProvider = {
      async listIssuesByLabel() {
        return [issue(1), issue(2)];
      },
      async getIssueDependencies(issueId: number): Promise<IssueDependencies> {
        return { issueId, blockers: [], dependents: [] };
      },
    };

    const next = await findNextIssueForRole(
      provider,
      "developer",
      DEFAULT_WORKFLOW,
      undefined,
      {
        isEligible: ({ issue }) => ({
          ok: issue.iid === 1,
          reason: "not-ready",
        }),
        onIneligible: async () => {
          throw new Error("callback failed");
        },
      },
    );

    assert.ok(next);
    assert.strictEqual(next!.issue.iid, 1);
  });
});
