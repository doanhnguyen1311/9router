# Reopened Phase 3 — Approved session to local Codex worker

Starting checkpoint: `96c06296`.

## Existing execution pipeline reused

The existing signed ticket, worker authentication, workspace validation, atomic claim, heartbeat, completion, cancellation, lease recovery, result redaction, verified memory and `CodexCliExecutor` remain authoritative. The reopened phase does not merge Codex API routing with Codex CLI execution.

## Handoff protocol

After explicit approval, the planning session advertises `prepare_execution`. A planning-aware local client submits:

- exact approved Plan version;
- stable worker ID;
- canonical absolute workspace root;
- Git branch and commit snapshot;
- working-tree snapshot hash;
- relevant file hashes;
- bounded timeout/ticket expiry.

The API-Key action endpoint rechecks exact key/Project ownership and delegates to the existing execution ticket service. It returns the signed, expiring, worker-bound ticket once in a no-store response. The database retains only the ticket hash.

Approval and execution remain separate actions. The server never guesses a local path and never treats a chat message as approval or execution authority.

## Session lifecycle

- `APPROVED` without execution: `prepare_execution`.
- `QUEUED`: poll or cancel.
- `EXECUTING`: poll or request cancellation.
- terminal: show filtered files, diff/test/token/error results.

Session polling exposes a sanitized execution view only; ticket IDs/hashes and raw workspace descriptors are not returned.

## Local CLI command

`9router execute-plan` will:

1. Read the API Key and worker secret from environment variables, not command-line arguments.
2. Require an explicit allowlisted canonical Git workspace.
3. Fetch the approved session and snapshot branch/commit/working tree/relevant files.
4. Prepare and immediately claim a scoped ticket.
5. Inspect the installed Codex CLI contract and invoke `codex exec` with `workspace-write`, ephemeral/ignored user configuration and rules, strict configuration, approval policy `never`, JSON output and no dangerous bypass flags.
6. Heartbeat, observe cancellation, collect bounded Git results and report completion.

The current supported deployment requires the 9Router worker endpoints to see the same canonical workspace path (same host or explicitly shared mount). Remote unshared workspaces fail closed during claim.

## Security decisions

- `EXECUTION_WORKSPACE_ROOTS` remains mandatory at both CLI preflight and server claim.
- Working-tree hash covers Git status, the binary tracked diff and bounded untracked contents, extending branch/commit/file checks so dirty-state drift is detected even when the status text is unchanged.
- Real `.env`/credential/private-key files, escaping/protected symlinks, oversized scans and excessive untracked content fail closed before Codex starts.
- Planning-generated shell text is never executed; Codex receives structured approved Plan JSON through stdin.
- API, worker and provider secrets are excluded from the Codex child environment and are never persisted in tickets, command arguments, logs or session responses.
- Duplicate prepare, ticket replay, wrong worker, stale source and out-of-root workspace fail closed.

## Gate

The gate requires the complete API-Key session → ticket → local worker → installed Codex CLI → sanitized result → same session cycle, plus cancellation/stale/replay/security regressions and production build. Token savings remain unclaimed unless a controlled A/B/C corpus is measured.
