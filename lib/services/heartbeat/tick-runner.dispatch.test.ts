import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("heartbeat tick-runner dispatch wiring", () => {
  it("forwards runtime to projectTick options", () => {
    const filePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "tick-runner.ts",
    );
    const src = fs.readFileSync(filePath, "utf-8");

    assert.match(
      src,
      /projectTick\(\{[\s\S]*runtime,[\s\S]*runCommand,[\s\S]*\}\)/m,
      "tick-runner should pass runtime into projectTick() dispatch path",
    );
  });
});
