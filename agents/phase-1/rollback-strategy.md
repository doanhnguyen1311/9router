# Phase 1 rollback strategy

## Application rollback

Revert the Phase 1 implementation checkpoint and restart 9Router. Existing API keys, provider routing, SSE and Project Memory continue to use their pre-Phase-1 paths because Planning is only exposed through new routes.

## Database rollback

Migration 005 is additive. The safest application rollback is to leave the four Planning tables in place; older code ignores them and no legacy column changed. Do not drop them automatically because that would destroy plans/audit history.

If the migration itself corrupts or blocks startup, stop the service and manually restore the pre-schema backup created under `DATA_DIR/db/backups/schema-14-to-15-*`. Preserve the failed database separately before restoration. Plans created after that backup are not present in the restored copy.

## Verification after rollback

- Start against a copy of the database first.
- Run `PRAGMA foreign_key_check` and the migration-chain tests.
- Verify `/v1/chat/completions`, SSE, existing API keys and Project CRUD.
- Do not deploy or restore over production without an operator-approved backup window.
