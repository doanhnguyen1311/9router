# Reopened Phase 3 rollback strategy

1. Stop local `9router execute-plan` workers and prevent new `prepare_execution` actions.
2. Allow a safely running worker to finish or request cancellation and wait for a recorded terminal state; do not blindly retry non-idempotent edits.
3. Revert implementation checkpoint `138905ed`.
4. Keep the additive `planExecutions` and audit records. No migration was introduced by this checkpoint and no table should be dropped.
5. Rotate `EXECUTION_WORKER_SECRET` and `EXECUTION_TICKET_SECRET` if compromise is suspected.
6. Re-run legacy API-Key, Codex provider, SSE and Planning regressions before reopening traffic.

The user-owned root `AGENTS.md` is not part of the checkpoint and must not be removed or reset.
