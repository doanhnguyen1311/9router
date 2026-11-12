# Proposed Phase 1 implementation plan

Status: `READY_AFTER_PHASE_0_CHECKPOINT`

## Scope

Implement only Planning Foundation: provider abstraction, bounded project context assembly, intent/options/revisions, strict state transitions, SQLite persistence, project-scoped APIs, audit, and tests. No approval execution, dashboard, or Codex workspace changes.

## Proposed sequence

1. Start from the PASS Phase 0 checkpoint and record the Phase 1 starting HEAD/working tree.
2. Define JSON schemas for intent, clarification, options, final plan, and provider error classes.
3. Add planning tables through a versioned migration and schema-version bump. Use foreign keys, status/version constraints, timestamps, expiry, creator/API-key IDs, provider/model identity, and immutable context snapshot hashes. Never store plaintext API keys.
4. Implement `PlanningProvider` with capability/health checks, timeout/cancellation, bounded retry, structured-output validation, and usage accounting. Provider/model are selected configuration, not hardcoded.
5. Build a context assembler around existing Project Memory retrieval, pinned/structured memory, graph, file/symbol/dependency data, ranking/dedup/provenance, secret filtering, and a strict token budget.
6. Implement a transactionally enforced state machine with explicit preconditions, RBAC, optimistic versions, audit events, clarification, cancellation, stale, and expiration handling.
7. Implement repositories/services for create/list/get/options/feedback/revision/selection/request-approval/cancel under project-scoped versioned API conventions.
8. Add unit/integration/security/concurrency/restart tests, then run the complete baseline suite, build, lint, migration verification, and performance comparison.

## Acceptance tests

- Structured plan generation and invalid-output rejection.
- Missing-information/clarification behavior without promoting assumptions to decisions.
- Context ranking, budget, provenance, secret exclusion, and cross-project isolation.
- Project roles and API-key/global/user/project permission inheritance.
- Revision immutability, option selection, state-transition matrix, optimistic conflicts, cancellation, stale/expiration behavior.
- SQLite restart recovery, migration from Phase 0 schema, concurrent writes, and backup restore verification.
- Planning OFF preserves every existing API path and response shape.
- Full regression/build/lint/security gate; zero unresolved Critical/High findings.

## Rollback boundary

Application rollback is the Phase 0 commit/checkpoint. Database rollback is restore from the migration-created backup using the older binary; no destructive down migration or table drop is planned.
