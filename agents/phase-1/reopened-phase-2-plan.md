# Reopened Phase 2 implementation plan

Starting point: Phase 1 checkpoint `11af71e8a94529c9c38375d8e1ab005ddad0a6c6`.

## Scope

1. Add one API-key-owned, versioned action endpoint for `select_option`, `submit_feedback`, `revise`, `request_approval`, `approve`, `reject` and `cancel`.
2. Require `expectedVersion` for every state mutation and a separate strong idempotency value plus explicit approval scope for approval.
3. Return the same planning-session envelope after every action so IDE/CLI clients can drive the workflow without Project-dashboard cookies.
4. Keep dashboard Project Planning wired to the same backend and add a direct Plan deep link/state.
5. Update API Key configuration copy so `ADAPTIVE`, `FAIL_CLOSED` and `LEGACY_PATH` behavior is explicit.

## Mandatory tests

- Exact API Key ownership and cross-key/cross-Project denial.
- Invalid action/input/state/version tests.
- Concurrent option selection and concurrent approval; exactly one transition wins.
- Approval replay, nonce/idempotency and selected-option enforcement.
- Revision through the real configured Planning Provider.
- Dashboard action integration, permission/error/loading/conflict states.
- Old API Key/provider/SSE/dashboard regression, build, lint and migration verification.

## Gate

Phase 2 passes only when a client can receive options, revise/select, explicitly approve a specific version/option, and no execution is created before that approval. Phase 3 stays locked until this gate passes.
