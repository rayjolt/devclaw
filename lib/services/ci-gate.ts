import {
  CiState,
  type CiStatus,
  type IssueProvider,
} from "../providers/provider.js";

export type CiGateResult = {
  status: CiStatus;
  attempts: number;
};

export async function getCiStatusWithRetry(
  provider: Pick<IssueProvider, "getPrCiStatus">,
  issueId: number,
  attempts = 3,
): Promise<CiGateResult> {
  let last: CiStatus = {
    state: CiState.UNKNOWN,
    failedChecks: [],
    pendingChecks: [],
    summary: "CI status unavailable",
  };

  for (let i = 0; i < attempts; i++) {
    try {
      const status = await provider.getPrCiStatus(issueId);
      last = status;

      if (status.state !== CiState.UNKNOWN) {
        return { status, attempts: i + 1 };
      }

      // UNKNOWN is retried per policy (fail-closed only after all retries).
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** i));
        continue;
      }
      break;
    } catch (err) {
      last = {
        state: CiState.UNKNOWN,
        failedChecks: [],
        pendingChecks: [],
        summary: (err as Error).message ?? "CI status lookup failed",
      };
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** i));
      }
    }
  }

  return { status: last, attempts };
}

export function ciDiagnostics(status: CiStatus): string {
  if (status.state === CiState.FAIL) {
    const checks =
      status.failedChecks.length > 0
        ? status.failedChecks.join(", ")
        : "unknown check(s)";
    return `CI failed: ${checks}`;
  }
  if (status.state === CiState.PENDING) {
    const checks =
      status.pendingChecks.length > 0
        ? status.pendingChecks.join(", ")
        : "checks running";
    return `CI pending: ${checks}`;
  }
  if (status.state === CiState.UNKNOWN) {
    return `CI unknown: ${status.summary ?? "status unavailable"}`;
  }
  return "CI passed";
}
