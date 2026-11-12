# Phase 0 dependency map

## Current request and project paths

```text
Client / Dashboard
  -> Next proxy and dashboardGuard
  -> /api/v1/* or /api/projects/*
     -> API-key/dashboard identity
     -> keyAccess + model routing
     -> Project Memory runtime
        -> repository/RBAC
        -> bounded retrieval + contextSnapshots
        -> graphRepository + fileIntelligence + searchIndex
        -> durable extraction queue
     -> SSE chat/media handler
     -> provider executor (including Codex API executor)
     -> usage and request-detail repositories
  -> SQLite adapter (WAL/foreign keys/secure delete)
```

## Modules to reuse

- Identity and access: `src/lib/projectMemory/identity.js`, `repository.js`, `src/sse/services/keyAccess.js`, dashboard session guards.
- Context: `runtime.js`, `retrieval.js`, `graphRepository.js`, `fileIntelligence.js`, `searchIndex.js`, existing `contextSnapshots` table.
- Persistence: `src/lib/db/schema.js`, migration runner, adapter abstraction, JSON-column helpers.
- Provider/account plumbing: provider store, provider registry/constants, OAuth services, usage accounting, error/timeout conventions.
- Streaming and compatibility: `src/sse/handlers/chat.js`, `/api/v1/*`, and existing OpenAI-compatible routes remain untouched when planning is OFF.
- UI: Project Detail client, API-key configuration UI patterns, dashboard auth/session utilities.

## Extensions required by phase

- Phase 1: planning domain service, provider abstraction, schemas, state machine, repositories, versioned migration, project-scoped API routes, audit log, context snapshot binding.
- Phase 2: per-key planning configuration and Project Detail planning UI; secure approval endpoint with optimistic concurrency and replay prevention.
- Phase 3: execution-ticket issuer, local worker protocol, Codex CLI adapter, workspace/revision validator, leases/cancellation/result persistence, verified memory updates.
- Phase 4: a separate read-only, project-scoped MCP surface and authenticated plan submission. It must not reuse unsupported ChatGPT session-cookie automation as an automated LLM backend.

## External/runtime dependencies

- SQLite is the system of record.
- Planning providers are outbound data processors and require explicit provider/model selection and disclosure boundaries.
- Codex CLI installed locally is `0.165.0`; `codex exec --json`/`--output-schema` are suitable for bounded automation, while `app-server` exposes a persistent protocol and authentication controls. Selection must be made during Phase 3 after worker lifecycle tests.
- Browser/Chrome is available and the existing chat-history Playwright smoke test passed.
