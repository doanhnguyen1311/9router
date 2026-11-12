# Phase 2 implementation plan

## Scope

Implement API-key Planning configuration and the real Project Planning/Human Approval dashboard. Codex execution remains prohibited until Phase 3.

## Sequence

1. Audit current API-key edit/storage/UI contracts and Project Detail component boundaries; record Phase 1 checkpoint and dirty tree.
2. Add an additive versioned migration for Planning configuration. Existing keys must read as `planningEnabled=false`; no legacy response format changes.
3. Implement Global → User → API Key effective Planning permission and validate provider/model/project assignment without returning credentials.
4. Add approval persistence and atomic service transitions with approver identity, selected option, exact plan revision/version, scope, nonce/idempotency and audit evidence.
5. Add versioned configuration, reject and approve APIs. Keep same-origin/CSRF, RBAC, replay prevention and optimistic concurrency at the backend.
6. Build Project Detail Planning UI: list/create/detail, intent, options comparison, feedback, revisions, selection, approval/rejection/cancel and status/error/expired/conflict states.
7. Add API-key Planning controls for OFF/MANUAL/ADAPTIVE. ADAPTIVE may suggest Planning but cannot change old client protocols or execute work.
8. Test component accessibility/responsiveness and backend integration, including two concurrent approvals with exactly one commit and zero executions.
9. Run build, full lint, full regression, security/dependency audit, migration backup/restore and performance comparison before opening Phase 3.

## Acceptance guardrails

- Old API keys remain OFF and follow the old request path.
- Viewer cannot mutate/approve; hidden buttons are not a security control.
- Approval requires a structured authenticated endpoint, never free-form chat text.
- Approval never starts Codex in Phase 2.
