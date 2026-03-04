import type { IssueProvider } from "../../providers/provider.js";

export type TerminalBlockedReason =
  | "merge_conflict"
  | "pr_not_merged_auto_merge_off"
  | "pr_closed_unmerged"
  | "pr_status_unavailable";

function normalizePrUrl(prUrl: string | null): string {
  return prUrl ?? "";
}

function signatureFor(
  issueId: number,
  reason: TerminalBlockedReason,
  prUrl: string | null,
): string {
  return `${issueId}|${reason}|${normalizePrUrl(prUrl)}`;
}

function markerFor(signature: string): string {
  return `<!-- devclaw:terminal-completion-blocked:${signature} -->`;
}

function messageFor(
  reason: TerminalBlockedReason,
  prUrl: string | null,
): string {
  if (reason === "merge_conflict") {
    return `⚠️ DevClaw blocked terminal completion: PR has merge conflicts (${prUrl ?? "no PR url"}).`;
  }
  if (reason === "pr_not_merged_auto_merge_off") {
    return `⏸️ DevClaw blocked terminal completion: auto-merge is off and PR is not merged yet (${prUrl ?? "no PR url"}). Merge the PR, then the heartbeat will close this issue.`;
  }
  if (reason === "pr_closed_unmerged") {
    return `⚠️ DevClaw blocked terminal completion: PR was closed without merging (${prUrl ?? "no PR url"}).`;
  }
  return "⚠️ DevClaw blocked terminal completion: unable to verify PR mergeability/merge state.";
}

/**
 * Post at most one blocked-terminal user comment per (issueId, reason, prUrl) signature.
 * Uses recent comment lookup for restart-safe dedupe.
 */
export async function postTerminalBlockedCommentOnce(opts: {
  provider: IssueProvider;
  issueId: number;
  reason: TerminalBlockedReason;
  prUrl: string | null;
}): Promise<boolean> {
  const { provider, issueId, reason, prUrl } = opts;
  const message = messageFor(reason, prUrl);
  const signature = signatureFor(issueId, reason, prUrl);
  const marker = markerFor(signature);

  const comments = await provider.listComments(issueId);
  const alreadyPosted = comments.some(
    (comment) =>
      comment.body.includes(marker) || comment.body.trim() === message,
  );
  if (alreadyPosted) return false;

  await provider.addComment(issueId, `${message}\n\n${marker}`);
  return true;
}
