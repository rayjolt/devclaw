import { describe, it } from "node:test";
import assert from "node:assert";
import { findNextIssueForRole } from "./queue-scan.js";
import { DEFAULT_WORKFLOW } from "../workflow/index.js";
import type { Issue, IssueDependencies, IssueProvider } from "../providers/provider.js";

type QueueProvider = Pick<IssueProvider, "listIssuesByLabel" | "getIssueDependencies">;

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
  it("skips blocked issues and dispatches the next unblocked issue", async () => {
    const provider: QueueProvider = {
      async listIssuesByLabel() {
        return [issue(1), issue(2)];
      },
      async getIssueDependencies(issueId: number): Promise<IssueDependencies> {
        if (issueId === 2) {
          return {
            issueId,
            blockers: [{ iid: 10, title: "blocker", state: "OPEN", web_url: "u", relation: "blocked_by" }],
            dependents: [],
          };
        }
        return { issueId, blockers: [], dependents: [] };
      },
    };

    const next = await findNextIssueForRole(provider, "developer", DEFAULT_WORKFLOW);
    assert.ok(next);
    assert.strictEqual(next!.issue.iid, 1);
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
            blockers: [{ iid: 11, title: "rejected blocker", state: "CLOSED", web_url: "u", labels: ["Rejected"], relation: "blocked_by" }],
            dependents: [],
          };
        }
        return { issueId, blockers: [], dependents: [] };
      },
    };

    const next = await findNextIssueForRole(provider, "developer", DEFAULT_WORKFLOW);
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
            { iid: 20, title: "done blocker", state: "CLOSED", web_url: "u", labels: ["Done"], relation: "blocked_by" },
            { iid: 21, title: "closed blocker", state: "CLOSED", web_url: "u", relation: "blocked_by" },
          ],
          dependents: [],
        };
      },
    };

    const next = await findNextIssueForRole(provider, "developer", DEFAULT_WORKFLOW);
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

    const next = await findNextIssueForRole(provider, "developer", DEFAULT_WORKFLOW);
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

    const next = await findNextIssueForRole(provider, "developer", DEFAULT_WORKFLOW);
    assert.ok(next);
    assert.strictEqual(next!.issue.iid, 12);
    assert.strictEqual(attempts, 3);
  });
});
