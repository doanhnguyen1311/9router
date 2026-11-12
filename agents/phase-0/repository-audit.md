# Phase 0 repository audit

Audit date: 2026-11-12 (Asia/Ho_Chi_Minh)

## Git and workspace

- Repository: `9router`
- Branch: `master`
- HEAD: `9a71aba83a99d2801162391b37c42a98c8451a3c`
- Upstream: `origin/master`
- Initial uncommitted state: only `AGENTS.md`, untracked and user-owned.
- Audit output and approved Phase 0 remediation changes are staged for the Phase 0 checkpoint; the user-owned untracked `AGENTS.md` remains preserved.
- Approximately 2,078 tracked files, including 459 tracked `*.test.js` files.

## Runtime and frameworks

- Node installed: `v22.23.2`; `.nvmrc`: `22.23.4` (patch mismatch).
- npm: `10.9.8`; Corepack: `0.34.6`.
- Root app: Next.js declared `^16.4.2`, validated locally at `16.4.6`; React `19.2.4`.
- Test runner: Vitest `5.1.0` for the final gate.
- Database: SQLite through `better-sqlite3`, `node:sqlite`, and `sql.js` adapters.
- Schema constant: version `14`; versioned migrations 1–4 plus additive schema synchronization.
- Root package exposes build/start scripts but no `test`, `lint`, or standalone `typecheck` script.
- CLI build dependencies are installed and its package/MITM build passes.

## Build, package, CI

- Root production build PASS when `DATA_DIR` is an isolated temporary directory.
- Next build performs TypeScript validation successfully, but no repository-wide typecheck command exists.
- Root and CLI builds PASS; root build is forced to a temporary `DATA_DIR`.
- Production dependency audit reports zero vulnerabilities in both manifests; `node-forge` and `undici` drift is resolved.
- Optional Next/sharp WASM helpers may still appear as extraneous top-level packages after npm pruning, but `npm ls` exits successfully.
- Lockfiles exist locally for root/tests but are ignored; no tracked lockfile provides a reproducible install baseline.
- CI workflows publish Docker/tray artifacts and deploy GitBook, but no PR workflow runs build, lint, security audit, or the regression suite.

## Database safety

- Pragmas include WAL, foreign keys, 5-second busy timeout, and `secure_delete=ON`.
- Schema-changing startup creates a pre-schema backup and retains a bounded backup history.
- Fresh and upgrade migration tests PASS in isolated temporary databases.
- No automated down-migration framework exists; rollback is restore-forward, not `DROP TABLE`.

During the first build attempt, the application fallback opened `/home/doanh/.9router/db/data.sqlite` before the fallback was visible in output. Both builds were stopped and rerun with isolated `DATA_DIR` values. No migration or destructive command against that database was logged, but a pre-run hash was not captured, so unchanged state cannot be proven. This is recorded as an audit incident and all subsequent runtime/build tests used temporary databases.

## Existing module verification

Every handover path listed in `AGENTS.md` exists, including Project Memory runtime/retrieval/file intelligence/graph/identity, database schema, key access, chat handler, Codex and ChatGPT Web executors, OAuth Codex modules, API-key storage, provider store/constants, CLI tool connection, and Project Detail UI.

Verified capabilities in source and tests:

- Project CRUD, owner/editor/viewer access, API-key project assignment, and global → user → API key → project feature gates.
- Unassigned keys preserve the old request path.
- Bounded context retrieval with ranking, provenance-style labels, snapshots, graph/file relationships, and explicit untrusted-data delimiters.
- Durable jobs with lease expiry/recovery, retry/backoff, deduplication, and idempotent evidence hashes.
- Incremental file/ZIP import, traversal and symlink protection, archive limits, secret/PII redaction, symbol/dependency extraction, and related-file lookup.
- Encrypted API-key credential storage and migration away from plaintext storage tokens.

## NOT TESTED

- Live upstream provider calls requiring external credentials.
- Real SSE latency against an upstream LLM.
- Production-scale stress, multi-host worker behavior, and production database restore drills.
- Project dashboard browser automation: the only repository UI smoke test covers chat history rather than Project Detail.
