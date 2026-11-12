# Phase 3 implementation design

## Execution boundary

Phase 3 keeps the server-side Codex API provider separate from the local Codex CLI worker. The server authorizes a specific approved plan revision and issues a short-lived signed ticket. A local worker validates that ticket, claims the execution atomically, validates the workspace, then starts `codex exec` with a bounded prompt and `workspace-write` sandbox.

## Components

- `src/lib/execution/ticket.js`: HMAC ticket, nonce, expiry, worker binding and stored ticket hash.
- `src/lib/execution/auth.js`: constant-time worker bearer authentication using `EXECUTION_WORKER_SECRET`.
- `src/lib/execution/workspace.js`: canonical Git root, configured root allowlist, branch/commit/file-hash freshness, traversal and symlink checks.
- `src/lib/execution/codexCli.js`: actual CLI capability inspection, safe argument construction, process timeout/cancellation, secret redaction and usage parsing.
- `src/lib/execution/repository.js`: atomic claim/complete/cancel/recovery, leases, audit records, bounded result persistence and verified memory update.
- `src/lib/execution/worker.js`: heartbeat loop, cancellation propagation, disconnect handling and result reporting.
- Project APIs issue/list/read/cancel executions; worker APIs claim, heartbeat, complete, cancel and recover leases.

## State and invariants

Only `APPROVED` plans with the current revision, selected option and matching approval can receive a ticket. A ticket is single-use and bound to its execution, project, plan, revision and worker. The unique plan constraint prevents duplicate execution. Workspace or approval drift marks the execution `STALE`; it is never silently refreshed or retried. Expired leases become `FAILED` for manual review instead of replaying potentially non-idempotent work.

Only successful, exit-code-zero executions create a bounded project memory record, with plan/execution provenance. Worker-supplied logs and paths are treated as untrusted and sanitized again on the server.
