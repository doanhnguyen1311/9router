# Reopened Phase 1 migration verification

## Migration

- Schema version: `18 → 19`.
- Migration registry version: `009`.
- New table: `planningRequestBindings`.
- Change type: additive; no existing table or column is dropped or rewritten.

## Constraints and indexes

- `planId` is unique and cascades from `executionPlans`.
- `projectId` and `apiKeyId` are foreign-key constrained.
- `(apiKeyId, requestKeyHash)` is unique for replay/deduplication.
- Project chronology and optional hashed-client-session lookups are indexed.

## Verification

- Fresh temporary database migration: PASS.
- Existing-schema upgrade during isolated build: PASS.
- Atomic Plan plus request-binding transaction: PASS.
- Export/import round trip: PASS.
- `PRAGMA foreign_key_check`: no rows.
- Duplicate request race is converted to deterministic Plan reuse.

One cwd-sensitive regression test used the normal local development database at `/home/doanh/.9router/db/data.sqlite`; it performed only the additive migration and automatically created `/home/doanh/.9router/db/backups/schema-18-to-19-1.0.0-20261112-143813/data.sqlite`. No production database was used and the recoverable backup was retained.
