import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadInstanceName } from "./instance.js";
import { DATA_DIR } from "./setup/migrate-layout.js";

describe("loadInstanceName", () => {
  let tmpDir: string;

  async function createWorkspace(): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-instance-test-"));
    await fs.mkdir(path.join(tmpDir, DATA_DIR), { recursive: true });
    return tmpDir;
  }

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("auto-generates and persists a name on first call", async () => {
    const ws = await createWorkspace();
    const name = await loadInstanceName(ws);
    assert.ok(name);
    assert.strictEqual(typeof name, "string");

    const raw = await fs.readFile(path.join(ws, DATA_DIR, "instance.json"), "utf-8");
    const data = JSON.parse(raw);
    assert.strictEqual(data.name, name);
    assert.ok(data.createdAt);
  });

  it("returns the same name on subsequent calls", async () => {
    const ws = await createWorkspace();
    const first = await loadInstanceName(ws);
    const second = await loadInstanceName(ws);
    assert.strictEqual(first, second);
  });

  it("uses config override when provided", async () => {
    const ws = await createWorkspace();
    const name = await loadInstanceName(ws, "CustomBot");
    assert.strictEqual(name, "CustomBot");
  });

  it("config override takes precedence over persisted name", async () => {
    const ws = await createWorkspace();
    const autoName = await loadInstanceName(ws);
    const overrideName = await loadInstanceName(ws, "Override");
    assert.strictEqual(overrideName, "Override");
    assert.notStrictEqual(overrideName, autoName);
  });
});
