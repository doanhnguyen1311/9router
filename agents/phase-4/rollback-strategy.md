# Phase 4 rollback strategy

Revoke active connectors first so all access and refresh tokens become unusable, then revert application checkpoint `b2242a36` and stop exposing the connector routes.

Schema 18 is additive; older application code ignores the connector tables. Do not automatically drop them because audit, revocation and plan provenance may be required. If a reviewed data restore is necessary, stop writers, preserve the current database and use the pre-schema 17→18 backup, then verify foreign keys and application startup.

No existing Provider, API key, SSE or Codex route is converted to the connector path, so disabling Phase 4 does not change legacy request behavior.
