# 9Router Project Memory Engine — Implementation Plan

_Repository audit date: 2026-11-09_

## Source-of-truth audit

9Router is a Next.js 16 application. Its OpenAI-, Anthropic-, Gemini- and
Responses-compatible routes all converge on `src/sse/handlers/chat.js` before
calling the provider-independent `open-sse` execution/translation layer. The
safe integration point for project context is therefore the shared handler,
after API-key authentication and before model/combo expansion. This keeps the
feature independent from upstream accounts and providers.

The application already has one SQLite database, selected through adapters in
`src/lib/db`, with WAL, foreign keys, additive schema synchronization,
versioned migrations and pre-schema backups. Project Memory will extend that
database rather than create another database. The `sql.js` fallback is retained;
features that depend on native FTS5 must have a relational `LIKE` fallback.

API keys are persisted in `apiKeys` and are already resolved once per request.
Project assignment will extend that row so an unassigned key takes a constant,
fail-open path and performs no retrieval, extraction or additional model call.

The dashboard auth token contains stable OIDC/SAML claims but the product has
no user table. Project ownership will use a normalized session principal:
`local-admin` for password/local mode, `oidc:<sub>` for OIDC, and a hashed
SAML e-mail principal. `project_members` makes sharing forward-compatible.
Every management endpoint still passes through the existing dashboard guard.

The existing `open-sse/utils/sessionManager.js` is provider-cache-oriented and
in-memory. Project virtual sessions will be a separate durable mapping keyed by
project, client namespace and client session. Provider account mappings are
metadata only and never imply transferable upstream conversation/KV state.

## Files and modules

### Persistence and domain services

- Extend `src/lib/db/schema.js` and add a reversible project-memory migration.
- Add repositories under `src/lib/projectMemory/repositories/` for projects,
  permissions, memories, graph, sessions, files, queue and snapshots.
- Add orchestration under `src/lib/projectMemory/` for permission resolution,
  request normalization, heuristic extraction, durable jobs, retrieval,
  context construction, response observation and worker recovery.
- Store imported files beneath the existing `DATA_DIR`, namespaced by project.
  Database rows hold metadata and a bounded, redacted text snapshot only.

### API and gateway

- Add `/api/projects/*` management endpoints for CRUD, members, files, memory,
  graph, sessions, analytics, settings and admin access controls.
- Extend `/api/key-usage` with assignment data and a narrowly validated PATCH.
- Resolve a request-scoped project once in `src/sse/handlers/chat.js`; inject
  untrusted retrieved context as a clearly delimited user-context block and
  observe the completed response asynchronously. All memory failures fail open.

### UI

- Add a Projects dashboard list and detail workspace with Overview, Knowledge
  Graph, Memories, Files & Knowledge, Sessions, API Keys, Analytics and Settings.
- Extend the existing public Key Usage page with Project Assignment rather than
  creating a second key-usage view.
- Add Projects to the existing sidebar design system.

## Database migration

The migration adds project ownership/membership, layered permission overrides,
API-key assignment, durable sessions, memory items/history/events/jobs,
entities/relations, files/symbols/dependencies, settings, snapshots and usage.
All project-owned rows use foreign keys and indexes that begin with `projectId`
to preserve isolation. API-key deletion removes only its assignment. Project
deletion is explicit and cascades project-owned knowledge after a confirmation
token; ownership transfer is transactional.

FTS5 is created opportunistically at runtime because not every configured
SQLite adapter is compiled with it. Search always has an indexed relational
fallback.

## Dependency map

```text
apiKeys -> project_api_keys -> projects -> project_members
                                  |
                                  +-> sessions
                                  +-> memory_events -> extraction_jobs -> memory_items/history
                                  +-> memory_entities -> memory_relations
                                  +-> project_files -> symbols/dependencies
                                  +-> context_snapshots / memory_usage

incoming request -> project resolver -> retrieval/context builder -> provider
completed response -> minimal event -> durable job -> extraction worker -> graph
uploaded file -> validator/redactor/parser -> file graph/search -> retrieval
```

## Risks and controls

- **Backward compatibility:** every gateway integration is guarded by an
  effective permission and non-null assignment; failures return the original
  body unchanged. Feature, retrieval and extraction switches are independent.
- **Prompt injection:** retrieved memory/file text is marked untrusted data,
  never emitted as a system/developer instruction, bounded by byte/token budget,
  and escapes delimiter-like text.
- **Upload abuse:** normalized relative paths, ZIP central-directory validation,
  compression-ratio/entry/expanded-size limits, symlink rejection, ignored and
  secret-file rules, secret redaction, no execution, and project quotas.
- **Queue duplication:** idempotency keys are unique; job lease/recovery and the
  memory upsert run transactionally. Failed jobs use capped exponential backoff
  and dead-letter status.
- **SQLite contention:** short transactions, bounded batches, indexed project
  predicates and asynchronous extraction. Existing WAL/busy timeout remain.
- **Identity evolution:** principals are opaque strings and membership is
  separate from API-key assignment, allowing a future user table migration.

## Test plan

- Unit tests for validation, effective permissions, project resolution,
  extraction/provenance/conflicts, graph traversal, context safety/budget,
  parser/dependencies, ZIP defenses, incremental hash behavior and queue leases.
- Integration tests for CRUD/assignment, cross-project denial, file upload and
  re-index/delete, session persistence, retrieval and feature switches.
- Compatibility tests assert that unassigned keys and disabled/unavailable
  Project Memory return the original request object and enqueue nothing.
- Run the existing focused API-key/gateway suites, the complete new suite,
  lint/build, and a measured local benchmark. Results will be recorded, not
  estimated.

## Rollback and recovery

1. Set global `enabled=false` to immediately restore the legacy request path.
2. Independently disable retrieval/extraction/file indexing for diagnosis.
3. A pre-schema SQLite backup is produced by the existing migration runner.
4. The migration exposes a `down` definition for controlled development
   rollback; production recovery should restore the pre-migration backup after
   stopping 9Router and retaining the current database for forensics.
5. Durable jobs with expired leases are returned to pending on the next worker
   start. Indexed files can be re-indexed from their stored import artifact.

Implementation will be delivered in dependency order: management/permissions,
durable sessions, memory/graph/retrieval, file intelligence, UI, then hardening
and documentation.
