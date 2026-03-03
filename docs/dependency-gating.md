# Dependency gating

DevClaw supports **dependency gating** for queued issues: if an issue has unresolved blockers, it will not be dispatched to workers.

## What counts as a blocker?

An issue is considered **blocked** when any dependency marked as **“blocked by”** is not resolved.

Resolution rules:

- If the blocker has the **`Rejected`** label, it is treated as **still blocking** (explicitly fail-closed).
- If the blocker has any workflow **terminal** state label (e.g. `Done`), it is **not blocking**.
- If labels are unavailable, DevClaw falls back to the provider’s issue state (`closed` / `done` / `merged` are treated as resolved).

## Provider failures (fail-closed)

Dependency status is fetched from the issue provider (GitHub/GitLab).
For GitHub, dependency edges are read from GraphQL `blockedBy` (blockers) and `blocking` (dependents).

- **Transient failures** are retried.
- If dependency lookup remains unavailable, DevClaw **fails closed** and treats the issue as blocked (it will not dispatch).

Troubleshooting:

- Ensure your provider tooling can access the repo (e.g. `gh auth status` for GitHub).
- Check rate limits and GraphQL/API availability.

## Circular dependency detection

If DevClaw can prove a **dependency cycle** (e.g. `#1 blocked by #2` and `#2 blocked by #1`), the issue cannot be actioned as-is.

Best-effort behavior:

- DevClaw transitions the queued issue to **`Refining`** so a human can break the cycle.
- If the provider supports comments, DevClaw leaves a short note explaining why.

How to fix:

- Remove the circular “blocked by” links in the issue tracker, or
- Close/resolve one side if it’s no longer relevant.
