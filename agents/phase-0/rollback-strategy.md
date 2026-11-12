# Phase 0 rollback strategy

Phase 0 includes approved baseline security/regression remediation and database migration 4.

## Workspace rollback

- Preserve the user-owned untracked `AGENTS.md`.
- Audit artifacts are isolated under `agents/`.
- No `git reset`, force checkout, or destructive cleanup was used.
- Baseline source checkpoint: `9a71aba83a99d2801162391b37c42a98c8451a3c` on `master`.
- Roll back application code by reverting the Phase 0 checkpoint commit, not by resetting the user's worktree.

## Database rollback

- Functional, migration, build, UI, and performance checks were rerun with temporary `DATA_DIR` directories.
- Migration 4 is forward-only and rewrites plaintext usage-key identifiers to HMAC values. It does not drop tables or usage counters.
- Startup creates the existing pre-schema backup before schema version 14 is stamped. Restore that verified backup with the prior binary if rollback is required; the plaintext key identifiers intentionally cannot be reconstructed from HMAC values.
- No production database was used for destructive testing.
- The first two aborted builds opened the default user DB before isolation was applied; no migration/destructive log was emitted, but a pre-run hash is unavailable. Do not claim cryptographic proof of no change.
- Future automation must refuse non-temporary test data directories and must capture a pre-change backup/hash before any schema phase.

## Phase 1+ strategy

- Before each schema phase: capture HEAD, dirty state, schema version, verified backup path/hash, and migration input.
- Use forward-only additive migrations with a schema-version bump and automatic pre-schema backup.
- Validate old data and old request paths before and after migration.
- Roll back code to the prior checkpoint and restore the verified pre-migration backup. Do not drop new tables in a live database as the primary rollback method.
