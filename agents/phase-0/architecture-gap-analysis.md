# Phase 0 architecture gap analysis

## Reusable foundation

The reported Project Memory system is real and usable: project RBAC, API-key assignment, bounded retrieval, snapshots, memory provenance/versioning, graph traversal, file intelligence, durable jobs, backup/import/export, retention controls, and SQLite safety are implemented and covered by focused passing tests.

Provider/account routing, OpenAI-compatible endpoints, SSE handling, cancellation signals, usage accounting, and Codex API integration also exist. Planning should wrap these abstractions rather than introduce a parallel provider/account system.

## Missing for Phase 1

- No planning domain/module, planning-provider interface, structured output schema, plan state machine, revision repository, or planning API exists.
- No planning tables (`executionPlans`, `planRevisions`, `planOptions`, approvals/audit/executions) exist in schema version 13.
- Existing context snapshots are tied to retrieval sessions; plans need immutable context-snapshot identity/hash and source revision metadata.
- There is no provider data-egress consent model specific to project planning.
- No plan-specific RBAC, optimistic versioning, cancellation, expiration, or audit events exist.

## Missing for later phases

- Phase 2: no per-key planning flags/modes, approval records, replay-safe approval transition, or planning dashboard.
- Phase 3: no execution ticket, worker identity, lease, workspace mapping, Git/hash freshness validation, Codex process adapter, or result/memory verification pipeline.
- Phase 4: no compliant project-scoped MCP planning server. The existing ChatGPT Web executor is an unrelated cookie/browser automation path and must not be promoted to this role.

## Compatibility risks

- Planning must default OFF and must not change existing API response shapes or hold legacy SSE requests open for approval.
- Schema changes must preserve all current records and use the migration/backup framework.
- Adding access fields has already caused stale key-access assertions; planning configuration must be introduced with explicit backward-compatible serialization tests.
- Provider fallback can leak project context to an unapproved processor; no implicit cross-provider fallback is allowed.
- Existing usage aggregation leaks raw keys and must be remediated before new audit/plan telemetry is trusted.
- Build/test data-dir fallback can touch local user state and must be isolated in automation.

## Codex execution constraints

Local Codex CLI is `0.165.0`. `codex exec` supports JSONL events, final JSON Schema validation, sandbox selection, workspace selection, and non-interactive execution. `app-server` is experimental but supports persistent transports and WebSocket authentication modes. Phase 3 must choose the smallest supported surface that still provides cancellation, approval boundaries, structured result collection, and crash recovery; it must never use the dangerous bypass flags as the security boundary.

## Decision

The requested architecture is feasible on the current foundation, but Phase 1 is not safe to start until Phase 0 security, dependency, CLI build, and regression blockers are resolved and the gate is rerun.
