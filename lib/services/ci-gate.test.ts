import { describe, it } from "node:test";
import assert from "node:assert";
import { ciDiagnostics, getCiStatusWithRetry } from "./ci-gate.js";
import { CiState } from "../providers/provider.js";

describe("getCiStatusWithRetry", () => {
  it("retries UNKNOWN responses up to max attempts", async () => {
    let calls = 0;
    const provider = {
      async getPrCiStatus() {
        calls++;
        return { state: CiState.UNKNOWN, failedChecks: [], pendingChecks: [], summary: "not ready" };
      },
    };

    const result = await getCiStatusWithRetry(provider as any, 1, 3);
    assert.strictEqual(calls, 3);
    assert.strictEqual(result.attempts, 3);
    assert.strictEqual(result.status.state, CiState.UNKNOWN);
  });

  it("stops retrying when a non-UNKNOWN status arrives", async () => {
    let calls = 0;
    const provider = {
      async getPrCiStatus() {
        calls++;
        if (calls < 3) return { state: CiState.UNKNOWN, failedChecks: [], pendingChecks: [] };
        return { state: CiState.PASS, failedChecks: [], pendingChecks: [] };
      },
    };

    const result = await getCiStatusWithRetry(provider as any, 1, 3);
    assert.strictEqual(calls, 3);
    assert.strictEqual(result.status.state, CiState.PASS);
  });

  it("prefers known failing checks over UNKNOWN fallback diagnostics", async () => {
    let calls = 0;
    const provider = {
      async getPrCiStatus() {
        calls++;
        if (calls === 1) {
          return {
            state: CiState.UNKNOWN,
            failedChecks: ["quality"],
            pendingChecks: [],
            summary: "PR head SHA unavailable",
          };
        }
        return {
          state: CiState.UNKNOWN,
          failedChecks: [],
          pendingChecks: [],
          summary: "PR head SHA unavailable",
        };
      },
    };

    const result = await getCiStatusWithRetry(provider as any, 1, 2);
    assert.strictEqual(result.status.state, CiState.FAIL);
    assert.ok(result.status.failedChecks.includes("quality"));
    assert.strictEqual(ciDiagnostics(result.status), "CI failed: quality");
  });
});
