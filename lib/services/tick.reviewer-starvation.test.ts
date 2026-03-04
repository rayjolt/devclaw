import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectTick } from "./tick.js";
import { DEFAULT_WORKFLOW, ReviewPolicy } from "../workflow/index.js";
import { createTestHarness } from "../testing/index.js";

/**
 * Regression test for Issue #50: reviewer head-of-line blocking.
 *
 * If the first scanned `To Review` issue is ineligible for reviewer dispatch
 * (e.g. `review:human`), the scan must continue until it finds an eligible
 * one (e.g. `review:agent`).
 */
describe("projectTick — reviewer queue starvation", () => {
  it("skips ineligible items and continues scanning To Review", async () => {
    const h = await createTestHarness();

    // Seed in an order that reproduces head-of-line blocking:
    // the scan iterates the provider list in reverse order.
    h.provider.seedIssue({
      iid: 410,
      title: "Eligible agent review",
      labels: ["To Review", "review:agent"],
    });
    h.provider.seedIssue({
      iid: 411,
      title: "Human review A",
      labels: ["To Review", "review:human"],
    });
    h.provider.seedIssue({
      iid: 412,
      title: "Human review B",
      labels: ["To Review", "review:human"],
    });

    const result = await projectTick({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      agentId: "test-agent",
      targetRole: "reviewer",
      workflow: { ...DEFAULT_WORKFLOW, reviewPolicy: ReviewPolicy.AGENT },
      provider: h.provider,
      runCommand: h.runCommand,
    });

    assert.equal(result.pickups.length, 1);
    assert.equal(result.pickups[0].role, "reviewer");
    assert.equal(result.pickups[0].issueId, 410);

    const reviewerSkips = result.skipped
      .filter((s) => s.role === "reviewer")
      .map((s) => s.reason)
      .join("\n");

    assert.ok(
      reviewerSkips.includes("review:human"),
      `expected skip reasons to include review:human, got:\n${reviewerSkips}`,
    );
  });
});
