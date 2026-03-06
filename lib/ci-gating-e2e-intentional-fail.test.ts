import test from "node:test";
import assert from "node:assert/strict";

/**
 * CI-gating E2E test fixture for issue #88.
 *
 * This test is intentionally failing to force CI red and verify that
 * workflow.ciGating=true blocks merge and routes to To Improve.
 */
test("CI-gating E2E fixture: intentionally fail CI for routing verification (#88)", () => {
  assert.equal(
    1,
    2,
    "Intentional failure for CI-gating E2E verification (remove after test).",
  );
});
