import { describe, it } from "node:test";
import assert from "node:assert";
import { findNextIssueForRole } from "./queue-scan.js";
import { TestProvider } from "../testing/test-provider.js";
import { DEFAULT_WORKFLOW } from "../workflow/index.js";

describe("findNextIssueForRole dependency gating", () => {
  it("B depending on A should not be selected until A resolves", async () => {
    const provider = new TestProvider();
    provider.seedIssue({ iid: 1, title: "A", labels: ["Doing"], state: "opened" });
    provider.seedIssue({ iid: 2, title: "B", labels: ["To Do"], state: "opened" });
    provider.setDependencies(2, [1]);

    let next = await findNextIssueForRole(provider, "developer", DEFAULT_WORKFLOW);
    assert.strictEqual(next, null, "B must stay blocked while A is open");

    const blocker = await provider.getIssue(1);
    blocker.state = "closed";
    blocker.labels = ["Done"];

    next = await findNextIssueForRole(provider, "developer", DEFAULT_WORKFLOW);
    assert.ok(next, "B should be eligible after blocker resolves");
    assert.strictEqual(next!.issue.iid, 2);
  });

  it("multi-blocker and rejected-blocker semantics", async () => {
    const provider = new TestProvider();
    provider.seedIssue({ iid: 10, title: "Resolved blocker", labels: ["Done"], state: "closed" });
    provider.seedIssue({ iid: 11, title: "Rejected blocker", labels: ["Rejected"], state: "closed" });
    provider.seedIssue({ iid: 12, title: "Blocked issue", labels: ["To Do"], state: "opened" });
    provider.setDependencies(12, [10, 11]);

    const next = await findNextIssueForRole(provider, "developer", DEFAULT_WORKFLOW);
    assert.strictEqual(next, null, "Rejected blocker must still block downstream issue");
  });

  it("retries dependency reads and fails closed when uncertain", async () => {
    const provider = new TestProvider();
    provider.seedIssue({ iid: 20, title: "B", labels: ["To Do"], state: "opened" });

    let attempts = 0;
    provider.getDependencyBlockedMap = async () => {
      attempts += 1;
      throw new Error("temporary dependency read failure");
    };

    const next = await findNextIssueForRole(provider, "developer", DEFAULT_WORKFLOW);
    assert.strictEqual(attempts, 3, "should retry dependency reads 3 times");
    assert.strictEqual(next, null, "should fail closed and skip dispatch when uncertain");
  });

  it("no-dependency projects remain unchanged", async () => {
    const provider = new TestProvider();
    provider.seedIssue({ iid: 30, title: "Unblocked task", labels: ["To Do"], state: "opened" });

    const next = await findNextIssueForRole(provider, "developer", DEFAULT_WORKFLOW);
    assert.ok(next);
    assert.strictEqual(next!.issue.iid, 30);
  });
});
