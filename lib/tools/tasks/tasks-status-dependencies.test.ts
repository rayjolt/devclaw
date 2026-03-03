import { describe, it } from "node:test";
import assert from "node:assert";
import { DEFAULT_WORKFLOW } from "../../workflow/index.js";
import { getDependencyGateStatus } from "../../services/queue-scan.js";
import type { IssueDependency } from "../../providers/provider.js";

describe("dependency gating", () => {
  it("marks open blockers as blocked (kind=dependency) and includes blocker IDs in reason", async () => {
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

    const gate = await getDependencyGateStatus(provider as any, { iid: 2 }, DEFAULT_WORKFLOW);
    assert.strictEqual(gate.blocked, true);
    assert.strictEqual(gate.kind, "dependency");
    assert.match(gate.reason ?? "", /#10/);
  });

  it("treats Rejected blockers as still blocking", async () => {
    const blocker: IssueDependency = {
      iid: 11,
      title: "Rejected blocker",
      state: "CLOSED",
      labels: ["Rejected"],
      web_url: "u",
      relation: "blocked_by",
    };

    const provider = {
      async getIssueDependencies(issueId: number) {
        return { issueId, blockers: [blocker], dependents: [] };
      },
    };

    const gate = await getDependencyGateStatus(provider as any, { iid: 2 }, DEFAULT_WORKFLOW);
    assert.strictEqual(gate.blocked, true);
  });

  it("treats Done blockers as resolved", async () => {
    const blocker: IssueDependency = {
      iid: 12,
      title: "Done blocker",
      state: "CLOSED",
      labels: ["Done"],
      web_url: "u",
      relation: "blocked_by",
    };

    const provider = {
      async getIssueDependencies(issueId: number) {
        return { issueId, blockers: [blocker], dependents: [] };
      },
    };

    const gate = await getDependencyGateStatus(provider as any, { iid: 2 }, DEFAULT_WORKFLOW);
    assert.deepStrictEqual(gate, { blocked: false });
  });

  it("surfaces dependency lookup failure as fail-closed blocked (kind=uncertain)", async () => {
    const provider = {
      async getIssueDependencies() {
        throw new Error("provider timeout");
      },
    };

    const gate = await getDependencyGateStatus(provider as any, { iid: 2 }, DEFAULT_WORKFLOW);
    assert.strictEqual(gate.blocked, true);
    assert.strictEqual(gate.kind, "uncertain");
    assert.match(gate.reason ?? "", /unavailable|failed/i);
  });
});
