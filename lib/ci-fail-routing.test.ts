import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("CI fail routing E2E marker", () => {
  it("intentionally fails to validate To Improve routing when CI is red", () => {
    assert.strictEqual(
      true,
      false,
      "Intentional CI failure for issue #86 E2E gating scenario",
    );
  });
});
