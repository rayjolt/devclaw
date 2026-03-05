import { CiState, type CiStatus, type IssueProvider } from "../providers/provider.js";

export type CiGateResult = {
  status: CiStatus;
  attempts: number;
};

export async function getCiStatusWithRetry(
  provider: Pick<IssueProvider, "getPrCiStatus">,
  issueId: number,
  attempts = 3,
): Promise<CiGateResult> {
  let last: CiStatus = { state: CiState.UNKNOWN, failedChecks: [], pendingChecks: [], summary: "CI status unavailable" };
  const knownFailedChecks = new Set<string>();

  for (let i = 0; i < attempts; i++) {
    try {
      const status = await provider.getPrCiStatus(issueId);
      last = status;
      for (const check of status.failedChecks ?? []) knownFailedChecks.add(check);
      if (status.state !== CiState.UNKNOWN) {
        return { status, attempts: i + 1 };
      }
      // UNKNOWN is retried per policy (fail-closed only after all retries).
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (2 ** i)));
        continue;
      }
      if (knownFailedChecks.size > 0) {
        return {
          status: {
            state: CiState.FAIL,
            failedChecks: [...knownFailedChecks],
            pendingChecks: [],
            summary: status.summary,
          },
          attempts: i + 1,
        };
      }
      return { status, attempts: i + 1 };
    } catch (err) {
      last = {
        state: CiState.UNKNOWN,
        failedChecks: [],
        pendingChecks: [],
        summary: (err as Error).message ?? "CI status lookup failed",
      };
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (2 ** i)));
      }
    }
  }

  return { status: last, attempts };
}

export function ciDiagnostics(status: CiStatus): string {
  if (status.state === CiState.FAIL || (status.failedChecks?.length ?? 0) > 0) {
    const checks = status.failedChecks.length > 0 ? status.failedChecks.join(", ") : "unknown check(s)";
    return `CI failed: ${checks}`;
  }
  if (status.state === CiState.PENDING) {
    const checks = status.pendingChecks.length > 0 ? status.pendingChecks.join(", ") : "checks running";
    return `CI pending: ${checks}`;
  }
  if (status.state === CiState.UNKNOWN) {
    return `CI unknown: ${status.summary ?? "status unavailable"}`;
  }
  return "CI passed";
}
