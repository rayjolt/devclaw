import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nameFromSeed, slotName, NAMES } from "./names.js";

describe("NAMES pool", () => {
  it("has enough names to be collision-resistant", () => {
    assert.ok(NAMES.length > 1000);
  });
});

describe("nameFromSeed", () => {
  it("is deterministic — same seed always returns same name", () => {
    const a = nameFromSeed("test-seed");
    const b = nameFromSeed("test-seed");
    assert.strictEqual(a, b);
  });

  it("returns different names for different seeds", () => {
    const a = nameFromSeed("seed-a");
    const b = nameFromSeed("seed-b");
    assert.notStrictEqual(a, b);
  });

  it("returns a name from the NAMES list", () => {
    const name = nameFromSeed("any-seed");
    assert.ok(NAMES.includes(name));
  });

  it("handles empty string seed", () => {
    const name = nameFromSeed("");
    assert.ok(NAMES.includes(name));
  });
});

describe("slotName", () => {
  it("is deterministic for the same slot coordinates", () => {
    const a = slotName("myapp", "developer", "medior", 0);
    const b = slotName("myapp", "developer", "medior", 0);
    assert.strictEqual(a, b);
  });

  it("returns different names for different slot indices", () => {
    const a = slotName("myapp", "developer", "medior", 0);
    const b = slotName("myapp", "developer", "medior", 1);
    assert.notStrictEqual(a, b);
  });

  it("returns different names for different roles", () => {
    const a = slotName("myapp", "developer", "medior", 0);
    const b = slotName("myapp", "tester", "medior", 0);
    assert.notStrictEqual(a, b);
  });

  it("returns different names for different projects", () => {
    const a = slotName("project-a", "developer", "medior", 0);
    const b = slotName("project-b", "developer", "medior", 0);
    assert.notStrictEqual(a, b);
  });

  it("produces no collisions for typical slot counts within a project", () => {
    const names = new Set<string>();
    const roles = ["developer", "tester", "reviewer"];
    const levels = ["junior", "medior", "senior"];
    for (const role of roles) {
      for (const level of levels) {
        for (let i = 0; i < 3; i++) {
          names.add(`${role}:${level}:${slotName("myapp", role, level, i)}`);
        }
      }
    }
    assert.strictEqual(names.size, 27);
  });
});
