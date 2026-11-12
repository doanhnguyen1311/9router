# Phase 3 security review

**Critical: 0. High: 0.**

Implemented controls:

- Signed, expiring, nonce-bearing, worker-bound execution tickets; only the ticket hash is persisted.
- Separate worker bearer secret with constant-time comparison; plaintext API keys are not execution tickets.
- Exact approved revision/option checks at issue and claim time; stale approval or source state cannot execute.
- Fail-closed `EXECUTION_WORKSPACE_ROOTS` allowlist, canonical Git root validation, symlink/traversal protection and relevant file hashes.
- Codex CLI uses `exec`, explicit workspace, `workspace-write` sandbox, timeout and abort; no dangerous bypass flag or direct execution of planner-produced shell commands.
- Atomic claim and unique constraints prevent replay and duplicate execution.
- Server-side bounded/redacted logs, errors and result paths; verified memory is written only for a successful execution.
- Cancellation, lease expiry and worker heartbeat failure stop work without unsafe automatic replay.
- Dependency audit reports zero known vulnerabilities.

Operational requirements:

- Set and rotate `EXECUTION_WORKER_SECRET` (minimum 32 characters) and restrict it to local execution workers.
- Configure `EXECUTION_WORKSPACE_ROOTS` explicitly for every worker host.
- Treat `EXECUTION_TICKET_SECRET` as server-only; if omitted, the installation-scoped CLI secret is used.
- The current worker credential is deployment-wide rather than per-device. Ticket worker binding limits its scope, but per-worker credential lifecycle is a future hardening item (Medium).
- Network isolation is delegated to the installed Codex `workspace-write` sandbox and host policy; deployments requiring stronger isolation should add an OS/container egress policy (Medium operational hardening).
