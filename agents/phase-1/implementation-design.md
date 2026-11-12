# Phase 1 implementation design

## Scope boundary

Phase 1 implements Planning Foundation only. It does not approve plans, execute Codex, modify a workspace, or add dashboard UI. Existing chat/SSE/API-key request paths remain unchanged unless a caller explicitly uses the new `/api/v1/projects/:id/plans` API.

## Architecture

- `PlanningProvider` defines capability validation, health, generation and revision contracts.
- `RouterPlanningProvider` calls one explicitly selected provider/model through 9Router's existing credential selection, translator and executor pipeline. It never changes provider on failure; account failover remains within the selected provider.
- The provider prompt treats Project context as untrusted data, requests a strict JSON document, validates it, redacts secret-like values and retries invalid/retryable output at most twice.
- `buildPlanningContext` reuses bounded Project Memory retrieval. Ranking covers pinned/structured memory, indexed files, symbols, related-file dependencies and graph entities, with provenance saved in an immutable planning snapshot.
- `service.js` orchestrates validation, context retrieval and provider calls. `repository.js` owns atomic persistence, RBAC, state transitions, optimistic version checks and audit logs.
- Versioned routes expose create/list/get/options/feedback/revision/select/request-approval/cancel operations. Approval itself remains Phase 2.

## State machine in Phase 1

`DRAFT` transitions only through validated generation to `NEEDS_CLARIFICATION` or `OPTIONS_READY`; an initial provider failure becomes `FAILED`. Revisions return to one of the same two validated states. Selecting an option keeps/returns the plan to `OPTIONS_READY`; requesting approval moves it to `PENDING_APPROVAL`. Mutable plans can become `CANCELLED` or `EXPIRED`. No Phase 1 endpoint can create `APPROVED` or `EXECUTING`.

Every mutation requires owner/editor role, a positive `expectedVersion`, an allowed source state, a conditional update and an audit row in the same transaction. Viewer access is read-only.

## Compatibility

- No existing API-key columns or defaults changed in Phase 1.
- No existing request is routed into Planning.
- Provider transforms/custom prompts are disabled for internal planning calls so chat preferences cannot alter the structured planning contract.
- External cancellation is wired into the existing provider stream controller without changing normal callers.
