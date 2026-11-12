# Phase 2 migration verification

- Schema version: `15 → 16`.
- Migration: `006-planning-approval`.
- Existing database upgrade tests passed from schema 1, 5, 8 and 10 fixtures.
- Existing API-key rows remained readable and retain legacy behavior; planning defaults OFF.
- `planApprovals` has project/plan/option foreign keys, `decision` and fixed `scope` checks, unique `(planId)` and unique nonce hash indexes.
- Export/import includes API-key planning fields and `planApprovals`; selected-option foreign-key cycles restore atomically with deferred checks.
- `PRAGMA foreign_key_check` returned zero violations in approval, planning benchmark and backup/import tests.
- No production database was used; all migration tests use temporary SQLite databases and automatic pre-schema backups.
