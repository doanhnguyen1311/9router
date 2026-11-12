# Reopened Phase 3 security review

**Critical: 0. High: 0.**

## Verified controls

- Execution begins only after an explicit structured approval with exact Plan version and selected option.
- Tickets are signed, expiring, nonce-bearing, worker-bound and replay-protected; only a hash is persisted and the plaintext ticket is returned only in the prepare response.
- API-Key identity is rechecked against the assigned Project. Dashboard execution reads/cancellation use Project RBAC.
- Canonical workspace roots must match `EXECUTION_WORKSPACE_ROOTS`; branch, commit, dirty diff, untracked contents and relevant file hashes are snapshot-checked before claim.
- Protected secret files and private-key types, escaping/protected symlinks, path traversal, oversized scans and oversized untracked snapshots fail closed.
- Codex CLI receives a narrow environment allowlist, not 9Router/API/worker/provider secrets. Invocation uses `workspace-write`, `--ephemeral`, ignored user config/rules, strict config and approval policy `never`; no dangerous bypass flag is used.
- Planning text is supplied as an approved instruction document, never executed directly as shell commands.
- Logs, errors, structured test results and token usage are bounded and sanitized again on the server. Public execution objects omit internal ticket/source/lease fields.
- Cancellation, timeout, stale approval/source and duplicate/replay negative paths are tested.

## Operational requirements and residual risks

- **Medium:** `EXECUTION_WORKER_SECRET` is installation-wide. Rotate it, restrict it to worker hosts and move to per-worker credentials when device lifecycle management is added.
- **Medium:** `workspace-write` is the application baseline; deployments needing stronger egress/process isolation must add OS/container policy. Codex credentials still need narrowly scoped access through the configured Codex home.
- **Medium:** a network loss after ticket issuance but before the client receives/claims it can leave a queued ticket until an authorized operator cancels it. Do not persist plaintext tickets to solve this; a future resumable protocol should preserve hash-only storage.
- The worker intentionally rejects a repository containing real `.env`, credential or private-key files. Use a secret-free clean worktree and inject only narrowly scoped runtime credentials outside the workspace.

Dependency audit: 0 known production vulnerabilities.
