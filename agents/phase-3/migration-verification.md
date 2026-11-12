# Phase 3 migration verification

Schema version changed from 16 to 17 through migration `007-codex-execution`.

The additive `planExecutions` table stores project/plan/revision identity, ticket hash and nonce, worker binding, source revision and relevant file hashes, lease/heartbeat/cancellation state, bounded result fields, filtered logs, usage and terminal errors. Foreign keys, state checks and unique/index constraints are present.

Verification completed:

- Fresh temporary database applied migrations 1 through 7 during the production build.
- Existing-schema upgrade and repository persistence passed unit tests.
- Export/import preserves execution rows.
- Foreign-key enforcement rejects invalid execution ownership.
- Restart behavior is durable because state, lease and result records are SQLite-backed.

During regression testing, the local non-production database at `/home/doanh/.9router/db` was upgraded by the application migration path. Its automatic pre-schema backup is `/home/doanh/.9router/db/backups/schema-16-to-17-1.0.0-20261112-123408`. No production data or destructive migration was used.
