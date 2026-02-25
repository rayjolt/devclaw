import { describe, it } from "node:test";
import assert from "node:assert";
import { DEFAULT_WORKFLOW } from "../../workflow/index.js";
import { getBlockedMeta, isBlockingDependency } from "./tasks-status.js";
import type { IssueDependency } from "../../providers/provider.js";

describe("tasks_status dependency visibility", () => {
  it("marks open blockers as blocking and includes blocker IDs", async () => {
    const provider = {
      async getIssueDependencies(issueId: number) {
        return {
          issueId,
          blockers: [
            { iid: 10, title: "A", state: "OPEN", web_url: "u", relation: "blocked_by" as const },
          ],
          dependents: [],
        };
      },
    };

    const meta = await getBlockedMeta(provider as any, 2, DEFAULT_WORKFLOW);
    assert.strictEqual(meta.blocked, true);
    assert.deepStrictEqual(meta.blockerIds, [10]);
    assert.match(meta.blockedReason, /#10/);
  });

  it("treats Rejected blockers as still blocking", () => {
    const blocker: IssueDependency = {
      iid: 11,
      title: "Rejected blocker",
      state: "CLOSED",
      labels: ["Rejected"],
      web_url: "u",
      relation: "blocked_by",
    };
    assert.strictEqual(isBlockingDependency(blocker, DEFAULT_WORKFLOW), true);
  });

  it("treats Done blockers as resolved", () => {
    const blocker: IssueDependency = {
      iid: 12,
      title: "Done blocker",
      state: "CLOSED",
      labels: ["Done"],
      web_url: "u",
      relation: "blocked_by",
    };
    assert.strictEqual(isBlockingDependency(blocker, DEFAULT_WORKFLOW), false);
  });

  it("surfaces dependency lookup failure as fail-closed blocked reason", async () => {
    const provider = {
      async getIssueDependencies() {
        throw new Error("provider timeout");
      },
    };

    const meta = await getBlockedMeta(provider as any, 2, DEFAULT_WORKFLOW);
    assert.strictEqual(meta.blocked, true);
    assert.strictEqual(meta.dependencyLookupFailed, true);
    assert.match(meta.blockedReason, /fail-closed/i);
  });
});
