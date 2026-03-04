import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("attachment hook workspace isolation", () => {
  it("does not fall back to agents.defaults.workspace or ~/.openclaw/workspace-devclaw", () => {
    const filePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "attachment-hook.ts",
    );
    const src = fs.readFileSync(filePath, "utf-8");

    assert.match(src, /resolveRuntimeWorkspace\(/, "should use canonical resolver");
    assert.doesNotMatch(src, /agents\.defaults\.workspace/, "should not reference agents.defaults.workspace");
    assert.doesNotMatch(src, /workspace-devclaw/, "should not reference hardcoded workspace-devclaw fallback");
  });
});
