import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHarness } from "../../testing/harness.js";
import { testSkipPass } from "./test-skip.js";

describe("heartbeat/test-skip — terminal completion guard", () => {
  it("routes to To Improve and does not close when PR is conflicting (mergeable=false)", async () => {
    const h = await createTestHarness();
    try {
      h.provider.seedIssue({ iid: 1, title: "Conflict", labels: ["To Test", "test:skip"] });
      h.provider.setPrStatus(1, { state: "open", url: "https://example.com/pr/1", mergeable: false });

      const n = await testSkipPass({
        workspaceDir: h.workspaceDir,
        projectName: h.project.name,
        workflow: h.workflow,
        provider: h.provider,
      });

      assert.equal(n, 1, "should transition once (to feedback state)");

      const issue = await h.provider.getIssue(1);
      assert.ok(issue.labels.includes("To Improve"), `labels=${issue.labels.join(",")}`);
      assert.equal(issue.state, "opened", "should not close issue on conflict");

      assert.equal(h.provider.callsTo("closeIssue").length, 0);
    } finally {
      await h.cleanup();
    }
  });

  it("does not transition to Done (and does not close) when auto-merge is off and PR is not merged", async () => {
    const h = await createTestHarness();
    try {
      h.provider.seedIssue({ iid: 2, title: "Unmerged", labels: ["To Test", "test:skip"] });
      h.provider.setPrStatus(2, { state: "approved", url: "https://example.com/pr/2", mergeable: true });

      const n = await testSkipPass({
        workspaceDir: h.workspaceDir,
        projectName: h.project.name,
        workflow: h.workflow,
        provider: h.provider,
      });

      assert.equal(n, 0, "should not transition");

      const issue = await h.provider.getIssue(2);
      assert.ok(issue.labels.includes("To Test"), `labels=${issue.labels.join(",")}`);
      assert.ok(!issue.labels.includes("Done"));
      assert.equal(issue.state, "opened");

      assert.equal(h.provider.callsTo("closeIssue").length, 0);
      assert.equal(h.provider.callsTo("transitionLabel").length, 0);
    } finally {
      await h.cleanup();
    }
  });

  it("allows transition to Done + close after PR is merged", async () => {
    const h = await createTestHarness();
    try {
      h.provider.seedIssue({ iid: 3, title: "Merged", labels: ["To Test", "test:skip"] });
      h.provider.setPrStatus(3, { state: "merged", url: "https://example.com/pr/3", mergeable: true });

      const n = await testSkipPass({
        workspaceDir: h.workspaceDir,
        projectName: h.project.name,
        workflow: h.workflow,
        provider: h.provider,
      });

      assert.equal(n, 1);

      const issue = await h.provider.getIssue(3);
      assert.ok(issue.labels.includes("Done"), `labels=${issue.labels.join(",")}`);
      assert.equal(issue.state, "closed", "should close issue when completing");

      assert.equal(h.provider.callsTo("closeIssue").length, 1);
    } finally {
      await h.cleanup();
    }
  });

  it("treats mergeable=unknown as non-conflicting (still allows close when PR is merged)", async () => {
    const h = await createTestHarness();
    try {
      h.provider.seedIssue({ iid: 4, title: "Merged (unknown mergeable)", labels: ["To Test", "test:skip"] });
      // mergeable omitted/unknown — should not be treated as conflicting.
      h.provider.setPrStatus(4, { state: "merged", url: "https://example.com/pr/4" });

      const n = await testSkipPass({
        workspaceDir: h.workspaceDir,
        projectName: h.project.name,
        workflow: h.workflow,
        provider: h.provider,
      });

      assert.equal(n, 1);

      const issue = await h.provider.getIssue(4);
      assert.ok(issue.labels.includes("Done"), `labels=${issue.labels.join(",")}`);
      assert.equal(issue.state, "closed");

      assert.equal(h.provider.callsTo("closeIssue").length, 1);
    } finally {
      await h.cleanup();
    }
  });
});
