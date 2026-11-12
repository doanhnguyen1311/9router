# Reopened Phase 2 security review

## Result

- Critical: 0 open.
- High: 0 open.
- Medium: 0 open.
- Low: 0 open.
- Informational: 2 documented policy/client requirements.

## Verified controls

- Poll/action requests require an active, unexpired, Planning-enabled API Key.
- SQL ownership requires exact `planId + projectId + apiKeyId`; another key in the same Project receives `404`.
- Owner/editor Project RBAC is checked again by every service/repository mutation.
- Only seven enumerated actions and their allowed fields are accepted; bodies are limited to 128 KiB and service fields have narrower limits.
- Every mutation carries an exact Plan version. Conflicts return `409` and the safe current version.
- Approval binds the selected option/current revision and fixed `EXECUTE_APPROVED_PLAN` scope; nonce hashes are never returned.
- Concurrent approval commits one row/decision. Approval creates no execution.
- Bearer/API-Key credentials are explicit rather than ambient cookies. CORS enables planning-aware clients without weakening dashboard same-origin checks.
- Per-key write rate limiting protects the revision/action path and provides `Retry-After`.
- 5xx messages remain generic; no provider credentials, API Key, approval nonce or Project source are exposed.

## Informational

1. A Planning-enabled client must implement the 9Router `202` session/action protocol; Admin and Key Usage screens now state this.
2. Admin-selected `LEGACY_PATH` deliberately permits ordinary inference after transient planner failure. `FAIL_CLOSED` remains the default and is required where every request must stop for approval.
