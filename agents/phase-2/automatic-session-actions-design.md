# Reopened Phase 2 — API-Key planning session actions

Starting checkpoint: `4dcb52d12c13903c571abc2d5b962711be5fe665`.

## Existing components reused

- The Phase 2 Project dashboard and Project-cookie APIs remain the human review UI.
- `src/lib/planning/service.js` and `repository.js` remain the only state machine and persistence implementation.
- Existing optimistic concurrency, approval scope, option binding, nonce hashing, audit and Project RBAC are reused without duplication.

## Client protocol

The planning session advertises:

- `links.self`: authenticated API-Key polling.
- `links.actions`: one authenticated mutation endpoint.
- `links.dashboard`: a deep link to the exact Project/Plan.
- `availableActions`: state-dependent action names.

`POST links.actions` accepts one strict action object:

- `select_option`
- `submit_feedback`
- `revise`
- `request_approval`
- `approve`
- `reject`
- `cancel`

Every mutation requires `expectedVersion`. Approval/rejection additionally requires the selected current option, scope `EXECUTE_APPROVED_PLAN`, and a strong single-use idempotency value. Unknown actions and fields fail closed.

## Authentication and approval boundary

- The presented API Key must be active, unexpired, Planning-enabled and still assigned to the Plan's Project.
- The Plan must contain the exact same `apiKeyId`; same-Project keys receive `404`.
- Service/repository writer RBAC is rechecked after API-Key ownership.
- Bearer/API-key authentication is explicit and is not ambient browser-cookie authentication, so cross-origin clients use CORS preflight without weakening dashboard same-origin controls.
- Human approval is always required at runtime. Historical `approvalRequired=false` values do not bypass the state machine and are presented as required until a separately authorized non-human approval design exists.
- Approval never creates execution in Phase 2.

## Availability and abuse controls

- Action bodies retain the existing 128 KiB maximum and per-field service limits.
- Actions use the existing Project API write-rate bucket keyed by API Key.
- Provider revision receives request cancellation/abort.
- Conflicting versions return `409` with the current version; rate limiting returns `429` and `Retry-After`.

## UI and Key Usage

- Admin copy describes actual MANUAL/ADAPTIVE behavior and warns when `LEGACY_PATH` can bypass planning after a transient planner failure.
- Key Usage shows read-only administrator-controlled Planning mode and client instructions; self-service PATCH cannot change Planning configuration.
- Dashboard deep links open the Planning tab and select the exact Plan.

## Gate criteria

- Full request → options → revise → select → approval cycle works through the real configured Planning Provider and API-Key action endpoint.
- Exactly one concurrent approval commits and zero executions exist afterward.
- Cross-key, cross-Project, stale-version, invalid-scope, replay and malformed-action tests pass.
- Dashboard/admin/Key Usage UI builds and existing approval/provider regressions remain clean.
