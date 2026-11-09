# 9Router Project Memory Engine

Implementation and operations guide for the provider-independent Project Memory and Project File Intelligence features.

## What is implemented

Project Memory is optional and is resolved from an API-key assignment in the shared chat gateway. An unassigned key returns before Project Memory opens a project session, queries memory, builds context, or schedules extraction. Assigned requests use the same project identity across provider accounts while upstream conversation IDs and model KV caches remain provider/account-specific.

The implementation contains:

- Project CRUD, owner/editor/viewer membership, ownership transfer, locking, confirmed deletion, layered global/user/API-key permissions, and one active project assignment per API key.
- Durable virtual sessions keyed by project, client namespace, and client session ID. Provider/account is mutable routing metadata, not the session identity.
- SQLite-backed events and extraction jobs with leases, stale recovery, unique idempotency, capped exponential retry, failed/dead-letter state, backpressure, and 30/90-day completed/failed retention.
- Structured memories with provenance, confidence, versions, history, deduplication, source priority, pinned protection, and active/superseded/rejected/pinned/archived states.
- Per-project relational knowledge graphs, optional FTS5, bounded neighborhood traversal, ranked retrieval, token budgets, context snapshots, and usage analytics.
- File upload/folder upload/ZIP import, ignore rules, validation, secret/PII redaction, deterministic language parsers, symbols, import dependencies, incremental content hashes, retained redacted artifacts, related-file traversal, and search.
- Project list/detail UI with Overview, Knowledge Graph, Memories, Files & Knowledge, Sessions, API Keys, Analytics, and Settings tabs. The existing Key Usage page contains the new Project Assignment panel.

The implementation plan and source audit are in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## Runtime architecture

```text
API key authentication and access policy
              |
              +-- no project --> unchanged gateway path
              |
              +-- assigned project
                    -> effective permission resolver
                    -> persistent virtual session
                    -> ranked memory/file/graph retrieval
                    -> bounded untrusted user-context block
                    -> existing provider translators/executors
                    -> minimal request/tool/JSON-response events
                    -> durable extraction worker
                    -> memory + graph transaction
```

All supported chat protocols converge at `src/sse/handlers/chat.js`, so OpenAI Chat/Responses, Anthropic-compatible, Gemini-compatible, Codex and other supported IDE clients use the same project resolver. Context is appended only to a user turn and is explicitly marked untrusted; it is never promoted to a system or developer message.

Important modules:

- `repository.js`: projects, permissions, API-key assignment, and durable sessions.
- `runtime.js`: request-scoped gateway integration and fail-open response observation.
- `queue.js`, `extractor.js`, `memoryRepository.js`: events, jobs, extraction, deduplication, conflicts, and provenance.
- `graphRepository.js`, `searchIndex.js`, `retrieval.js`: graph, FTS/fallback search, ranking, context, and snapshots.
- `fileIntelligence.js`: path/ZIP defenses, redaction, parsers, symbols, dependency graph, and incremental indexing.
- `privacy.js`, `rateLimit.js`, `analytics.js`: best-effort sensitive-data filtering, API budgets, and operational statistics.

## Change inventory

New implementation groups:

- `src/lib/projectMemory/*.js`: domain, queue, retrieval, graph, file, privacy, rate-limit and analytics services.
- `src/lib/apiKeyStorage.js` and `src/lib/db/migrations/002-project-memory.js`: protected API-key storage and reversible Project Memory migration.
- `src/app/api/projects/**`: project, permission, member, assignment, session, memory, graph, file and analytics routes.
- `src/app/(dashboard)/dashboard/projects/**`: project list/detail workspace and graph viewer.
- `tests/unit/project-memory-*.test.js`, `tests/unit/project-file-intelligence.test.js`, and `tests/performance/project-memory-benchmark.test.js`.
- `docs/project-memory/IMPLEMENTATION_PLAN.md` and this operations guide.

Existing integration points changed:

- `src/sse/handlers/chat.js`: optional request-scoped resolution, context injection, route metadata and non-streaming response observation.
- `src/app/api/key-usage/route.js` and `src/app/key-usage/KeyUsageClient.js`: Project Assignment in the existing Key Usage flow.
- `src/app/api/keys/**` and `src/lib/db/repos/apiKeysRepo.js`: owner/project flags and protected key lookup/storage.
- `src/lib/db/{schema,index,migrate,backup}.js` and the migration registry: schema, import/export, legacy migration and backup behavior.
- `src/shared/components/Sidebar.js`: Projects navigation.
- `.gitignore`: tracks the Project Memory implementation/operations documentation.

## Database and migration

Schema backup version is `12`; versioned migration `002-project-memory.js` creates the Project Memory tables and protects legacy API keys. The existing database is reused with WAL, foreign keys, a five-second busy timeout, and `secure_delete=ON`. The FTS5 table is optional; relational search remains available when an SQLite driver lacks FTS5.

Logical tables are:

- `projectSystemSettings`, `projectPermissions`, `projects`, `projectMembers`, `projectApiKeys`, `projectSettings`
- `projectSessions`, `memoryEvents`, `extractionJobs`, `memoryItems`, `memoryItemHistory`
- `memoryEntities`, `memoryRelations`, `projectFiles`, `projectSymbols`, `projectFileDependencies`
- `contextSnapshots`, `memoryUsage`

API keys now store a keyed hash for lookup and an AES-256-GCM encrypted value for the administrative UI. The plaintext key is returned at creation and can be recovered only with the persistent application secret. Existing plaintext rows are rewrapped during migration, and database exports retain only protected fields.

Project deletion cascades project-owned database rows, unassigns keys, and removes retained redacted artifacts that resolve inside that project's storage directory; it never deletes the API keys themselves.

## API reference

All `/api/projects` routes require the existing dashboard identity and apply backend authorization plus per-process read/write rate budgets.

| Endpoint | Methods | Purpose |
|---|---|---|
| `/api/projects` | `GET`, `POST` | List/search and create projects |
| `/api/projects/:id` | `GET`, `PATCH`, `DELETE` | Details, metadata/state, confirmed deletion |
| `/api/projects/:id/members` | `GET`, `POST`, `DELETE` | List/add/change/revoke members; `POST action=transfer` transfers ownership |
| `/api/projects/:id/settings` | `GET`, `PATCH` | Memory, extraction, retrieval, file, retained-source, budget and graph switches |
| `/api/projects/:id/api-keys` | `GET`, `POST`, `DELETE` | List, assign, and unassign API keys |
| `/api/projects/:id/sessions` | `GET` | Durable client/provider/account mappings |
| `/api/projects/:id/memories` | `GET`, `POST` | Search/list and create confirmed memory |
| `/api/projects/:id/memories/:memoryId` | `GET`, `PATCH`, `DELETE` | History, edit/pin/archive, and delete |
| `/api/projects/:id/graph` | `GET` | Search/traverse a bounded graph neighborhood |
| `/api/projects/:id/files` | `GET`, `POST` | Search/list and multipart file/folder/ZIP import |
| `/api/projects/:id/files/:fileId` | `GET`, `POST`, `DELETE` | Details/symbols, re-index/cancel, and remove |
| `/api/projects/:id/files/:fileId/related` | `GET` | Related files plus evidence-bearing relationships |
| `/api/projects/:id/analytics` | `GET` | Memory, queue, retrieval, session, graph, and file metrics |
| `/api/projects/access` | `GET`, `PATCH` | Global, user, API-key access and global limits |
| `/api/key-usage` | `GET`, `PATCH` | Existing self-service page plus select/create/unassign project |

Mutation payloads are narrowly validated by their repositories. Responses use private no-store caching. Project errors return stable codes and do not expose database details.

## User guide

1. Open **Projects** in the dashboard and create a project.
2. Open the existing **Key Usage** page for an API key. Under **Project Assignment**, choose the project or create a new one. `No Project` is the default and preserves legacy behavior.
3. Use the project detail workspace:
   - **Memories** adds, edits, pins, archives, deletes and inspects provenance/history.
   - **Files & Knowledge** accepts files, browser-supported folders, and ZIP archives; unchanged content hashes are skipped.
   - **Knowledge Graph** searches and explores a bounded neighborhood with zoom, pan, filters and an inspector.
   - **Sessions** shows stable client sessions and current provider/account routing.
   - **API Keys** attaches multiple authorized keys to the same project.
   - **Settings** controls extraction/retrieval/file behavior, context budget, graph depth, shows membership, and provides lock/deletion controls. Authorized membership mutations use the members API until directory-backed discovery is available.
4. Start a new IDE/chat request with the assigned key. New requests resolve the current assignment; an already-started request retains the project captured at its start.

For file imports, paths are relative project paths. `.env`, credential/private-key files, binaries, dependency/build directories and matching ignore rules are skipped. Stored searchable content and retained source artifacts are redacted before writing.

## Administration

The Projects page **Access control** panel implements:

- Global Project, extraction, retrieval and file-intelligence switches.
- Default/current or arbitrary stable-principal user access.
- Per-API-key Project Access.
- Maximum projects per owner, files per project, bytes per project, and bytes per file.

Effective access is `global AND user AND API-key`. Disabling any layer keeps all data and assignments but prevents management/retrieval until access returns. For immediate incident rollback, turn off global Project access; requests then take the legacy gateway path.

`local-admin` is always the Project administrator. In OIDC/SAML multi-user deployments, set `PROJECT_ADMIN_PRINCIPALS` to a comma-separated list of stable opaque principal IDs that may use global controls and administratively inspect/lock projects. Other authenticated principals retain only owner/editor/viewer access to their projects.

Project ownership is separate from API keys. The members API supports owner/editor/viewer roles, revocation and transactional transfer. Until a directory-backed user browser exists, use stable principal IDs from the access response or identity provider when managing non-current users.

## Backup and restore

The application already creates a lightweight pre-schema backup before schema changes. A complete Project Memory backup requires both database state and retained artifacts.

Recommended backup procedure:

1. Stop 9Router or place it behind maintenance routing so no writes are active.
2. Preserve the complete `DATA_DIR/db` directory, including `data.sqlite` and the persistent application secret used by dashboard/API-key encryption.
3. Preserve `DATA_DIR/project-memory/files` when `retainSourceContent` is enabled.
4. Protect the backup as sensitive data. Database exports contain encrypted API-key material, redacted memory/file content, ownership and usage metadata.
5. Start 9Router and run `PRAGMA integrity_check` through the normal SQLite administration process after the copy.

Restore procedure:

1. Stop 9Router and retain the current data directory for forensics.
2. Restore the database, persistent application secret, and project artifact directory from the same backup generation.
3. Ensure the service account owns the restored files and directories.
4. Start 9Router. Migrations are idempotent and additive; inspect startup logs for driver/migration errors.
5. Verify an unassigned API key, an assigned API key, project membership, a retained-file re-index, queue state, and `PRAGMA integrity_check` before reopening traffic.

The JSON database export/import includes all Project Memory relational rows and protected API-key fields, but it does not copy retained artifact files or the encryption secret. Use it for logical migration only, with the artifact/secret copy steps above.

## Rollback and recovery

Fast functional rollback:

1. In **Projects → Access control**, set global Project access to OFF. No project data is removed.
2. If diagnosis needs finer isolation, leave global access on and separately turn off automatic extraction, retrieval, or file indexing.
3. Existing unassigned requests and all requests while access is disabled remain on the legacy path.

Database rollback:

1. Stop 9Router.
2. Retain the current database and artifacts.
3. Restore the matching pre-schema backup and application secret.
4. Deploy the previous application version and verify integrity before traffic resumes.

Migration `down()` exists for controlled development and drops Project Memory tables in reverse dependency order. It is not the preferred production rollback because dropping tables intentionally removes Project data and the additive API-key columns remain harmless. Restore the backup instead.

Queue recovery is automatic: processing jobs with expired 30-second leases return to pending. Memory writes and job completion share a transaction; unique fingerprints and event hashes prevent duplicates after retries. Failed jobs remain inspectable for 90 days by default.

## Security model

- Dashboard identity, role checks and project predicates are enforced in repositories, not only in UI.
- API-key assignment is optional; global/user/key/project switches are checked again at gateway resolution.
- API keys use HMAC lookup plus versioned AES-256-GCM ciphertext tied to the persistent application secret and machine binding.
- Context is bounded, delimiter-sanitized, labeled untrusted, and appended only to user content.
- Automatic events store at most 32 KiB of normalized text; common e-mail, SSN, payment-card, JWT and credential/token patterns are redacted first.
- ZIP processing validates the central directory, path, encryption flag, compression method, CRC, symlink mode, count, compressed/expanded size, and compression ratio. Archive content is never executed.
- Project/file quotas, queue backpressure, bounded queries and rate limits constrain resource abuse.
- SQLite foreign keys isolate namespaces; backups and FTS fallback avoid a second persistence system.
- `secure_delete=ON` reduces recoverable deleted content inside SQLite pages. It cannot guarantee erasure from SSD remapping, filesystem snapshots, WAL copies or backups; backup retention must be managed separately.

## Measured performance

Command:

```bash
tests/node_modules/.bin/vitest run --config tests/vitest.config.js tests/performance/project-memory-benchmark.test.js --reporter=dot
```

Measured on 2026-11-09 with Node `v22.23.2`, Linux x64 and `better-sqlite3`. Synthetic dataset: 2,000 memories, 300 graph entities, 50 TypeScript files and 200 durable queue events.

| Workload | Measured result |
|---|---:|
| Seed 2,000 memories with search updates | 1,372.61 ms |
| Seed 300 graph entities/299 edges | 18.65 ms |
| Index 50 files | 173.21 ms / 288.62 files/s |
| Ranked retrieval, 100 iterations | 8.35 ms average / 11.91 ms p95 |
| Three-level graph traversal, 100 iterations | 0.85 ms average / 1.30 ms p95 |
| Enqueue and process 200 jobs | 410.52 ms / 487.19 jobs/s |
| 50 concurrent retrieval promises | 360.50 ms total |
| 50 concurrent confirmed writes | 89.31 ms total |
| Example context overhead | 1,349 estimated tokens |
| SQLite file after workload/checkpoint | 3,715,072 bytes |

These are local synthetic measurements, not production SLOs. Results depend on CPU, storage, SQLite driver, query mix, artifact sizes and concurrent gateway traffic. The test is reproducible and records its environment and dataset in stdout.

## Verification status

- Project Memory/File Intelligence/security tests: 16 passed.
- Migration/API-key/quota/v2 focused regression tests: 25 passed.
- Gateway/provider compatibility tests: 64 passed, 10 skipped by their existing environment guards.
- Performance benchmark: 1 passed and emitted the measurements above.
- `npm run build`: passed with all project routes and dashboard pages collected.
- ESLint could not run in this checkout because the installed `eslint-config-next` requires a missing `typescript` package. The production build's JavaScript/React compilation and Next.js type phase passed; this lint dependency issue is not hidden as a successful lint run.

## Known limitations

- Automatic extraction is deterministic heuristic/rule-based. There is deliberately no hidden LLM call, provider configuration or extra upstream cost; an optional consented LLM extractor remains future work.
- Language adapters extract explicit symbols/imports with conservative static parsing and text fallbacks. They do not yet provide compiler-grade cross-language AST/type resolution or inferred `CALLS` edges.
- JSON responses can be observed without blocking. Unbounded SSE responses are not cloned, so assistant-only statements from streaming turns are not extracted; request and tool evidence still are, and assistant statements never prove task completion.
- There is no broad local-filesystem agent. Only uploaded content and content actually received from IDE/tool evidence is used; a path alone is not treated as readable or verified.
- Search uses exact/FTS/graph ranking; there is no vector database or embedding-based semantic search.
- The dashboard shows members, while add/revoke/transfer for non-current principals is exposed through the authorized members API until directory-backed discovery is available.
- The rate limiter is process-local. Multi-instance deployments should add a trusted shared edge/distributed limiter.
- PII/secret redaction is best-effort pattern detection and cannot prove that arbitrary sensitive values were found. Restrict filesystem/backups and review uploads according to organizational policy.
- ZIP64 is rejected rather than supported. `.gitignore` support covers common positive ignore rules; complex negation semantics are not a full Git implementation.
- Rotating the persistent application secret requires a controlled rewrap migration; no online key-rotation UI is currently provided. Back up that secret with the database.
- Account failover preserves project/session identity and knowledge, not upstream conversation state, stored item IDs or KV cache. The gateway does not replay unknown side-effecting tool calls.
