# Chat History

Chat History is opt-in. Open **Dashboard → Settings → Chat History**, sign in with a dashboard management session and enable **Collect conversation content**. The switch saves immediately, including when navigating away; wait for its saved confirmation. It stays disabled while loading/saving and rolls back with an error if the write fails. Retention and content-limit edits still use **Save history settings**. View requests at **Dashboard → Chat History**. Use a separate inference API key for each team member. A shared key identifies one group; the gateway has no separate per-person user/role model.

Choose **View detail** to read **Sent to AI** and **AI response**. The latest user message and following tool results are shown first; previous conversation and system/developer instructions can be expanded. Tool names/arguments/results and captured reasoning have distinct presentations. Protocol envelopes and raw sanitized payloads are collapsed. Text is escaped, with no HTML execution or remote media loading. Each detail fetch remains a separately authorized request; the list does not download conversation bodies. Records captured while disabled cannot be recovered, and older truncated records cannot regain missing messages.

The **API key** column and request Detail identify the sender by their API key's current display name and a short internal ID. Existing history resolves through its stored `ownerId`. Renaming a key changes the displayed name; deleted keys show **Deleted API key** and their ID, while requests with no established owner show **Unidentified**. People sharing a key share the same sender identity. Names are not historical snapshots, so a deleted key's former name cannot be recovered from History.

List/detail responses include `apiKey: { id, name, state }`, where `state` is `identified`, `deleted`, `unidentified` or `unavailable`. Only authorized records are enriched. A single bounded main-DB metadata query reads `id` and at most 200 characters of `name` for up to 50 IDs on a Dashboard read; it does not read key values or reset quotas. There is no extra lookup in inference/capture, queue or streaming. If that lookup fails, conversation data remains available with `unavailable` labels. No History schema migration is needed.

## Architecture and integration

The app is Next.js 16 / React 19, JavaScript ESM, running on Node (also supports Bun). Existing state is SQLite through bun:sqlite / better-sqlite3 / node:sqlite / sql.js adapters, with additive schema synchronization and JSON settings. Usage and request-detail repositories are separate existing features; Chat History does not replace or change them.

`src/sse/handlers/chat.js` parses the client body, authenticates the inference key, resolves model/key restrictions, expands model combos and capacity adapters, selects accounts, refreshes credentials and invokes `open-sse/handlers/chatCore.js`. Core handles protocol translation, executor retries, streaming and response translation. Account and combo fallback are separate layers. OpenAI Chat Completions, Anthropic Messages and OpenAI Responses enter this handler. Gemini chat converts to the internal format; its original messages/parts are supplied to capture separately. Native Gemini TTS/audio bypasses this chat handler and is not captured.

One collector wraps the **final client response** outside all retries/fallback. It snapshots only bounded, sanitized conversation fields before adapters mutate input, records up to 16 attempt summaries, and observes response bytes with a pull-driven stream. It does not tee, await SQLite, read ahead, change SSE bytes, touch adapters, or change retries/timeouts. Cancellation propagates to the original reader. Abort, read error, HTTP errors, in-band errors and missing SSE completion markers produce distinct history statuses. Invalid JSON and middleware-level rejections before the chat handler are not captured. Failures before key lookup can be unowned (admin only).

Response capture has a bounded prefix plus an 8 KiB tail for final usage/errors. Text and OpenAI tool-call deltas are assembled in the worker; native Claude/Responses blocks are preserved and native text/tool deltas are assembled before filtering. Oversized input/output is explicitly marked truncated. Partial JSON or partial SSE frames can lose individual messages/tool arguments. Binary/image/audio fields are omitted rather than decoded; URLs are omitted, including signed URLs. Each request remains independent (`conversation_id` is intentionally absent): routing session identity can include content-derived heuristics, so it is unsuitable for automatically joining private conversations.

## Queue, worker and storage

Input capture reserves space for recent user messages before large system prompts or old context. At most 64 messages are inspected per message array, preserving the first system/developer message where possible and the most recent context. The selected messages retain their original order and roles, with bounded per-message shares. Remaining capacity captures separate instructions/tool definitions. Omitted context or shortened content is marked truncated. This prevents a large Copilot system prompt from consuming all space before the user's question. Reasoning deltas are stored separately from the final assistant answer. All existing queue, record and active-capture limits remain enforced.

`src/lib/chatHistory/service.js` owns a process-global FIFO (survives Next dev reloads), one worker, and at most one in-flight batch. Enqueue serializes only the bounded snapshot. The hard queue limits are **50 records / 16 MiB (16,777,216 bytes)**, and each record is at most **512 KiB (524,288 bytes)**, including metadata and JSON encoding. Byte accounting uses the exact UTF-8 JSON envelope length. Queue entries own exactly sized, non-pooled buffers; no JSON string or original payload object remains in the queue. Buffers are transferred to the worker without copying, and their bytes/record count stay charged until the batch is acknowledged. Queue full drops the newest record immediately, without serialization or content traversal when saturation is already known. No dropped record is retried.

The 16 MiB limit is a **queue data budget**, not total Node.js RSS. Buffer wrappers, bounded queue bookkeeping, worker parsing/normalization, SQLite cache, active captures and transient serialization have separate overhead. At most 32 concurrent collectors and a separate 8 MiB reservation budget are admitted per process. Reservations are taken before content traversal, and released with their original size even if settings change. Each collector owns a bounded sanitized request snapshot plus fixed-size prefix/tail stream buffers; there is no per-chunk buffer list or reference to source chunk backing storage. Metadata, secret-filter inputs and JSON escaping are bounded during collection. Request/body/response references, abort listeners and stream readers are explicitly released when their lifecycle ends. Disabled history does not traverse request content; disabling also discards active capture and queued records. A batch already being written may finish.

The hot path serializes only the bounded completed record, once. The worker decodes/parses that envelope once and serializes the normalized, sanitized record for persistence; the search projection reuses that serialized string. Both incoming and persisted records are checked against 512 KiB. All History SQLite reads/writes, JSON response parsing, final filtering, searching and retention run in **worker_threads**, not on the proxy event loop. `worker.cjs` opens `DB_DIR/chat-history.sqlite` with WAL, NORMAL synchronous mode, 2 MiB page cache and 100 ms busy timeout. It uses node:sqlite, bun:sqlite or existing optional better-sqlite3. If no native driver works, history fails open; it does not fall back to a synchronous sql.js export on the main thread. No dependency or external service was added.

A dedicated SQLite file avoids concurrent writes to the main database when the app is using sql.js (which writes whole database images). The main schema and its migration version are unchanged. History's additive v1 migration uses `PRAGMA user_version=1` and `CREATE TABLE/INDEX IF NOT EXISTS` inside the worker; newer unknown schemas are refused. Data survives gateway upgrades without touching usage logs, provider credentials or API keys. Existing database backup/export/import/reset APIs do not include this separate file. Back up History separately with a SQLite-aware backup, or after stopping the app; include WAL if copying a running database.

Schema:

```sql
CREATE TABLE historyRequests (
  id TEXT PRIMARY KEY,       -- server-generated logical request UUID; idempotent insert
  ownerId TEXT,              -- internal API key ID; NULL is admin-only
  createdAt TEXT NOT NULL,   -- ISO UTC
  model TEXT, provider TEXT, status TEXT NOT NULL, httpStatus INTEGER,
  inputTokens INTEGER, outputTokens INTEGER,
  title TEXT, searchText TEXT, data TEXT NOT NULL
);
```

Indexes: `(ownerId, createdAt DESC)`, `(createdAt DESC)`, `(model, createdAt DESC)`, `(provider, createdAt DESC)`. `data` contains the sanitized request/response, requested/routed model, recognized client family, attempts, durations, errors, truncation and token usage. Search scans bounded sanitized content in the worker; it is intended for a small team, not a high-volume archive.

Flush every 2 seconds, at most 10 records per batch. Each record is caught independently. Busy/database failures drop records without retry. A failed/hung batch is abandoned after 5 seconds, the worker is terminated, and restart is delayed at least 30 seconds. Warning messages contain no record/exception contents and are rate limited to once per minute. RPCs are capped at 32 pending operations and time out after 3 seconds. Shutdown on `beforeExit` attempts a final flush/close with a 300 ms wait; forcible exits/SIGTERM handlers elsewhere in the app may lose pending data. No delivery guarantee is provided.

Retention runs at configuration/startup and every minute while the worker is running, including when capture is disabled and a history file exists. Each pass deletes at most 100 expired rows using the timestamp index, with a short write lock. Large backlogs may take several passes. Deletes free SQLite pages for reuse, not guaranteed physical disk erasure. SQLite files are not encrypted.

## Configuration

Existing `/api/settings` stores these fields; defaults/ranges are validated on history settings updates:

| Field | Default | Allowed |
| --- | ---: | --- |
| `chatHistoryEnabled` | false | boolean |
| `chatHistoryRetentionDays` | 30 | 1–365 |
| `chatHistoryQueueCapacity` | 50 | 1–50 |
| `chatHistoryQueueMaxBytes` | 16777216 | 65536–16777216 |
| `chatHistoryMaxContentBytes` | 65536 | 4096–262144 |
| `chatHistoryBatchSize` | 10 | fixed at 10 |
| `chatHistoryFlushIntervalMs` | 2000 | fixed at 2000 |

Old persisted settings are normalized to the new hard limits when read. PATCH attempts to exceed a hard limit are rejected. Worker concurrency is fixed at one. The UI exposes enabled, retention, record capacity and maximum content. Advanced settings use the existing PATCH API. These limits are conservative budgets: JSON escaping, privacy traversal and record overhead can cause earlier truncation/drops. Configuring more queue capacity never removes the byte/capture limits. Each process has independent queue/metrics; multiple gateway processes may share the native WAL file with best-effort contention handling.

## API contract and authorization

History routes always authenticate in their backend handler, even with `requireLogin=false`. A valid signed `auth_token` management cookie can manage all history (same authority as existing dashboard administrators, including SSO). An active, unexpired inference key in Bearer / x-api-key / x-goog-api-key can only read/delete its own internal key ID. Client query `admin`/`ownerId` values never grant permissions. Revoked/deleted keys lose read access; admin can still manage their retained history. Unowned local requests are admin-only. Cookie-based mutations reject mismatched Origin. Global settings changes require a signed management session; the CLI token and an inference key do not grant that right. UI does not store inference keys.

- `GET /api/chat-history?limit=20&offset=0&q=...&model=...&provider=...&status=...&from=<ISO>&to=<ISO>`: `{items, hasMore, offset, limit}`. Items contain summary metadata, not conversation bodies. Max page 50, offset 100000, text filters 200 chars. Exact model/provider/status match; content search is case-sensitive substring over sanitized content. Admin response additionally includes `metrics` (saved, dropped, activeDropped, errors, queueDepth, queueCapacity, queueBytes, queueMaxBytes, maxRecordBytes, active, captureReservedBytes, ready).
- `GET /api/chat-history?id=<UUID>`: sanitized detail object; 404 for missing/out-of-scope IDs. Response size is bounded by capture/worker sanitization budgets (under approximately 1 MiB).
- `DELETE /api/chat-history?id=<UUID>`: `{deleted, more:false}` scoped to caller.
- `DELETE /api/chat-history?all=true`: deletes up to 100 saved rows in caller's scope, returns `{deleted, more}`. Repeat while `more=true`. Pending/active requests may create records later; disable capture before clearing when needed.
- Errors: 400 invalid ID/date/delete arguments; 401 no valid authorized identity; 503 worker unavailable, overloaded or timed out. History responses use `Cache-Control:no-store` and `X-Content-Type-Options:nosniff`. Proxy endpoint contracts are unchanged.

Filtering never intentionally saves Authorization, cookies, credential fields, signatures, private keys, common API/JWT token formats or binary payloads. Known client/upstream credentials are also removed from bounded response buffers. No headers, stack traces or raw body are sent to application logs by History. Filtering arbitrary free text is inherently best effort: unknown secrets and credentials split inside unusual protocol structures may evade detection. Review privacy policy and enable only with the team's consent. Existing request-detail/debug logs have their own settings and policies.

## Validation

From `tests/`:

```sh
npx vitest run unit/chat-history.test.js unit/chat-history-auth.test.js
```

For real HTTP streaming/fallback through the actual handler/core/executor/translator (local provider fixture, no live provider calls):

```sh
# Run from repository root, separate terminal
postman simulation run postman/simulations/chat-history/chat-history.sim.yaml --port 14990 --no-history --output ndjson
# Then from tests/
HISTORY_TEST_UPSTREAM=http://127.0.0.1:14990/upstream npx vitest run unit/chat-history-proxy.test.js
# Optional alternating on/off benchmark, same fixture
HISTORY_TEST_UPSTREAM=http://127.0.0.1:14990/upstream HISTORY_BENCH=1 npx vitest run unit/chat-history-proxy.test.js
```

Simulation fixtures are test-only, use fake credentials, and can log fixture bodies. Integration tests mock settings/auth/account storage to avoid real credentials, but use real HTTP and the actual gateway/core/translation/fallback code. Without the environment variable, HTTP tests are explicitly skipped. Benchmark writes `/tmp/9router-history-benchmark.json` (override `HISTORY_BENCH_OUTPUT`). See [validation.md](validation.md) for measured results and their limits.

Build with an isolated data directory (`DATA_DIR=/tmp/9r-build npm run build`) because existing static-page collection can initialize the gateway database. Next tracing includes the unbundled worker/privacy CJS assets for standalone and CLI packaging; start with the standalone directory as cwd, as Next's standalone server does.

## Files changed

- `src/lib/chatHistory/config.js`, `src/lib/chatHistory/limits.cjs`: defaults and shared hard bounds for the app/worker.
- `src/lib/chatHistory/privacy.cjs`: bounded credential/binary filtering shared with the worker.
- `src/lib/chatHistory/collector.js`: bounded request snapshot and response stream observer.
- `src/lib/chatHistory/service.js`: global queue, admission limits, worker lifecycle, metrics and management RPC.
- `src/lib/chatHistory/worker.cjs`: native SQLite connection, v1 migration, capture normalization, scoped reads/deletes and retention.
- `src/lib/chatHistory/auth.js`: signed management session / active key-owner authorization.
- `src/sse/handlers/chat.js`, `src/sse/services/keyAccess.js`, `src/app/api/v1beta/models/[...path]/route.js`: logical request capture and existing identity lookup integration.
- `src/app/api/chat-history/route.js`, `src/dashboardGuard.js`: history management API with handler-level auth.
- `src/app/api/settings/route.js`, `src/lib/db/repos/settingsRepo.js`: reuse settings persistence, validation and runtime configuration.
- `src/instrumentation.js`, `next.config.mjs`: background retention startup and standalone worker tracing.
- `src/app/(dashboard)/dashboard/chat-history/page.js`, `src/shared/components/ChatHistorySettings.js`, `src/shared/components/Sidebar.js`, `src/app/(dashboard)/dashboard/profile/page.js`: history browser, navigation and settings UI.
- `tests/unit/chat-history.test.js`, `tests/unit/chat-history-auth.test.js`, `tests/unit/chat-history-proxy.test.js`: worker, isolation/API, real HTTP proxy integration and optional benchmark.
- `postman/mocks/chat-history-upstream/*`, `postman/simulations/chat-history/*`: local-only reusable provider simulation.
- `.gitignore`, `CHANGELOG.md`, `docs/chat-history/*`: tracked documentation, measured results and change record.
