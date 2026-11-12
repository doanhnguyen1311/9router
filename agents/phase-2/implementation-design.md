# Phase 2 implementation design

## Boundaries

- API keys carry an additive `planning` configuration. Existing rows and newly-created rows default to `planningEnabled=false`, `planningMode=OFF`; legacy requests never enter a planning wait state.
- Planning modes are `OFF`, `MANUAL`, and `ADAPTIVE`. Adaptive is configuration and dashboard policy only in this phase: it cannot rewrite an old HTTP/SSE response protocol or execute a task.
- Approval is a separate, authenticated API transition. The dashboard never treats free-form chat text as approval.
- Codex execution is intentionally absent. An `APPROVED` plan is persisted and inert until Phase 3.

## Backend

- `src/shared/utils/keyPlanning.js` validates mode, provider/model, token budget, expiration, approval and failure policy with bounded values.
- `src/lib/db/migrations/006-planning-approval.js` adds key columns and `planApprovals` with foreign keys, decision/scope checks, unique plan and nonce indexes.
- API-key serialization and import/export preserve planning settings without exposing credentials.
- `decidePlanApproval` checks writer RBAC, exact plan version, current selected option, current revision, fixed execution scope, one-decision invariant and a SHA-256 idempotency nonce inside one transaction.
- New versioned routes: `approve` and `reject`.

## Dashboard

- `ProjectPlanningPanel.jsx` is wired to the existing versioned Planning APIs, not a mock store.
- Project Detail has a Planning tab with create/list/detail, intent/context fields, options, comparison fields, feedback, revision, approval/rejection/cancellation, conflict retry and audit history.
- API Key management has a Planning tab with safe defaults, mode controls, provider/model, bounded context/expiration, approval requirement and failure policy.
- Loading, empty, unauthorized/read-only, expired, conflict and error states are represented; backend authorization remains authoritative.
