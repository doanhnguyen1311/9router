# Local validation

## Current memory limits revision

The current implementation enforces queue payload limits of 50 records / 16 MiB and a 512 KiB UTF-8 JSON envelope per record, including the in-flight batch. Batch size is 10, flush interval 2 seconds, worker concurrency one. Collection has a separate bounded reservation budget; none of these limits claim to cap total Node.js RSS.

The latest regression run passes **121 tests across 8 files**, with the optional benchmark skipped. Coverage includes exact byte-boundary admission, Unicode/JSON escaping, owned non-pooled buffer sizes, real buffer transfer and detached sender storage, in-flight byte/count accounting, no retries after drops, saturation admission without touching content, capture reservations across settings changes, large metadata/keys, 10,000 stream fragments, and reader/abort-listener cleanup. Existing streaming, auth, fallback and migration checks remain covered. The sections below preserve earlier implementation benchmark runs and must not be interpreted as measurements of this memory revision.

The optional HTTP benchmark was also run separately and all four tests passed. Current on/off measurements (100 requests per mode after 20 warmups):

| Metric | History disabled | History enabled |
| --- | ---: | ---: |
| Latency p50 / p95 | 10.73 / 18.64 ms | 11.00 / 19.25 ms |
| First-content-byte p50 / p95 | 4.16 / 10.60 ms | 4.36 / 12.13 ms |
| Observed stream throughput | 52.34 KiB/s | 50.88 KiB/s |
| Process CPU in sampled windows | 725.26 ms | 804.13 ms |
| Process peak RSS | 213.79 MiB | 213.67 MiB |

No dropped records/errors in this benchmark. Queue: 9 records / 11793 bytes (includes in-flight), capture reservations: zero at the sample boundary. Raw values: [benchmark-memory.json](benchmark-memory.json). The same short fixture and shared-process limitations as the earlier benchmark apply: these are synthetic results, the worker is already started in both modes, process RSS is not the queue budget, and these numbers do not establish production performance or zero overhead.

A production standalone build, ESLint and `git diff --check` pass. A real Next server + Chromium smoke test confirms all hard settings limits are enforced at the API (oversized queue limits, non-10 batch size and non-2000-ms interval are rejected), worker assets including shared limits are packaged, transferred-buffer records are persisted, key isolation still holds, and History/Settings render without browser JavaScript errors. Build/runtime use isolated temporary databases.

## Earlier baseline runs

Node 22.23.2, Linux, 2026-10-29. SQLite history uses node:sqlite in a worker; main application selects better-sqlite3. No live AI provider was called.

An alternating on/off benchmark after 20 warmups collected 100 streamed requests per mode through the real chat handler, core, HTTP executor and translator against the local Postman simulation (three SSE frames with ~2 ms delay between frames). Authentication/settings/account persistence were test fixtures. "Disabled" is the implementation with capture disabled, not an independently built pre-change release. These short synthetic streams do not establish production tail latency, concurrency limits, long-context cost or maximum streaming bandwidth.

| Metric | Disabled | Enabled |
| --- | ---: | ---: |
| Request latency p50 | 11.18 ms | 11.31 ms |
| Request latency p95 | 13.25 ms | 13.38 ms |
| First-content-byte p50 | 4.18 ms | 4.48 ms |
| First-content-byte p95 | 7.59 ms | 7.24 ms |
| Observed stream throughput | 54.86 KiB/s | 54.75 KiB/s |
| Process CPU, timed windows | 829.19 ms | 759.86 ms |
| Process peak RSS | 214.50 MiB | 214.00 MiB |

Noise dominates small differences. Both modes run in one process with an already started worker; RSS is not the incremental cost of enabling a worker, and CPU includes background work occurring in sampled windows. The ~0.13 ms p50 latency increase is evidence of nonzero capture overhead. The fixture contains tiny message context; measure representative team workloads before drawing performance conclusions. Raw measurements: [benchmark-local.json](benchmark-local.json).

At the sample boundary: 0 drops/errors, queue depth 9, queue bytes 11791, no active collectors; 115 records had been acknowledged. Queue was flushed periodically outside measured request windows; this is not a durability test.

Automated checks cover bounded capture/queue, UTF-8 chunk boundaries, tool calls, native Claude deltas, in-band/HTTP failures, abort/cancel/interruption, EOF without terminal marker, storage busy/malformed records/crash, disabled capture, retention and restart configuration, owner isolation, anonymous/revoked/expired credentials, origin checks, content sanitization, actual HTTP combo fallback and unchanged JSON protocol responses. Main DB migration-chain and existing streaming/fallback regression checks are run separately.

Existing failures observed outside the new feature: three `key-access.test.js` helper assertions expect the old shape without account restriction fields (reproduced against HEAD's original keyAccess module); one `combo-credit-fallback.test.js` case expects a generic 400 to stop combo fallback, while current unchanged combo logic falls through. These modules were not refactored.

Final checks: 17 worker/capture/privacy tests and 5 API authorization tests pass; 4 HTTP integration/optional benchmark tests pass. Existing migration, combo routing, empty-stream fallback, request-scoped fallback and fusion checks contribute 88 passing tests. The optional benchmark is skipped by default. ESLint on added files and changed backend integration files, `git diff --check`, and a production standalone build pass.

An isolated standalone smoke test (real Next HTTP server and Chromium) also passed: worker assets are present and execute; a failed inference request is recorded; separate real API keys cannot list/read/delete each other's records; history stays protected with `requireLogin=false`; an inference key cannot enable history; admin deletion works; History list/detail and Settings render without browser JavaScript errors. SQLite database/WAL/SHM permissions are restricted to owner access on Linux. No live upstream credentials were used. Native Gemini TTS/audio, Bun runtime, Windows packaging, and live provider-specific protocol variants remain unverified.

## Original-handler comparison

A separate run loaded `git show HEAD:src/sse/handlers/chat.js` into a temporary adjacent module and used it for the baseline branch of the same benchmark. The current handler with History enabled was the comparison branch; temporary source/test files were removed afterward. All four tests in that run passed. Auth/settings/account fixtures and the already started worker were shared, so this compares the changed proxy path rather than whole-process startup or main DB costs.

| Metric | Original HEAD handler | Current handler, History enabled |
| --- | ---: | ---: |
| Request latency p50 | 11.07 ms | 11.34 ms |
| Request latency p95 | 13.14 ms | 14.11 ms |
| First-content-byte p50 | 4.15 ms | 4.46 ms |
| First-content-byte p95 | 7.10 ms | 9.05 ms |
| Observed stream throughput | 55.67 KiB/s | 53.96 KiB/s |
| Process CPU, timed windows | 783.43 ms | 825.59 ms |
| Process peak RSS | 214.92 MiB | 214.92 MiB |

100 measured requests per mode, 20 warmups; zero dropped records/errors. At the sample boundary, queue depth was 9 / 11790 bytes and no collectors were active. This run shows measurable overhead (~0.27 ms p50 request latency, ~0.97 ms p95), with additional scheduler noise in first-byte tails. It is not a claim of zero overhead or a production performance guarantee. Raw values and baseline commit: [benchmark-before-after.json](benchmark-before-after.json).

The first build used the environment's default data directory and triggered the repository's existing main-DB migration from schema 6 to 8, which created a pre-schema backup at `/home/doanh/.9router/db/backups/schema-6-to-8-0.5.112-20261029-141037`. Subsequent builds and standalone tests used isolated `/tmp/9router-history-validation/` databases. The History implementation itself does not change the main DB schema.

## Capture switch and readable details (2026-10-29)

The switch previously changed only local form state until the separate Save button was pressed. It now PATCHes only `chatHistoryEnabled` immediately, uses a keepalive write during navigation, prevents edits before initial load/during save, and rolls back with an error on failure. Numeric drafts still require explicit Save. Detail uses the same scoped API and now presents escaped user/assistant text, instructions/context, tool calls/results and reasoning separately. Missing content in an older truncated record is reported rather than reconstructed.

Input capture now allocates bounded space to recent messages before long system instructions, preserving roles and original message order. A regression with a million-character system prompt retains the latest Vietnamese user question and its assistant response, stays within the existing payload budget, and displays a truncation notice. Native Responses reasoning and tool names/arguments are tested separately from the final answer.

Validation: **202 passing tests across 17 focused/regression files**, with the optional benchmark skipped in that run. A separate benchmark run passed all four HTTP tests. Production build, lint on changed History modules and `git diff --check` passed. [Chrome smoke automation](../../tests/ui/chat-history.smoke.cjs) passed against a standalone server with a temporary SQLite database: initial-load guard, immediate navigation while saving, new tab, reload, persisted off state, failed-write rollback, numeric drafts, readable user/AI/tools, escaped markup, detail retry and scoped deletion. No paid/live inference was used.

Run that UI check against a temporary standalone instance with `HISTORY_TEST_BASE_URL`, `HISTORY_TEST_PASSWORD` and `HISTORY_TEST_DATA_DIR` set. The script refuses data directories outside a `/tmp/9router-history-detail-…` prefix (or the equivalent OS temp directory). It uses the existing `playwright-core` installation and local Chrome; `HISTORY_BROWSER_PATH` can override the executable. Runtime tests/builds for this change used `/tmp/9router-history-detail-validation/`.

| Enabled-mode metric | Before these fixes | After these fixes |
| --- | ---: | ---: |
| Request latency p50 / p95 | 10.92 / 13.12 ms | 10.81 / 11.95 ms |
| First-content-byte p50 / p95 | 4.35 / 6.79 ms | 4.32 / 6.07 ms |
| Observed stream throughput | 56.36 KiB/s | 57.76 KiB/s |
| Process CPU, sampled windows | 721.36 ms | 693.48 ms |
| Process peak RSS | 215.21 MiB | 215.22 MiB |

Same local mock setup, 20 warmups and 100 measured requests per mode. Both runs reported zero dropped records/errors, queue capacity 50 and a 16 MiB byte ceiling. After the fix, the disabled p50 latency was 10.67 ms versus enabled 10.81 ms, so capture still has measurable cost. Differences between runs include scheduling/JIT/GC noise; this small-message fixture does not establish long-context or production performance, and RSS comes from a shared process/worker. Raw measurements: [benchmark-detail-capture.json](benchmark-detail-capture.json).

## API key names in History (2026-10-29)

List/detail now enrich already authorized records with bounded `apiKey` metadata from the current key ID/name. Existing records work without backfill or a schema change. The metadata query does not select key values, run quota resets or execute in the inference path. Deleted, unidentified and temporarily unavailable key names have distinct labels. Names reflect current configuration rather than a historical snapshot.

Validation: **208 passing tests across 18 focused/regression files**, with one optional benchmark skipped. Six new tests use actual SQLite metadata queries and the History route to check admin/owner scope, absent/deleted keys, current/unnamed/redacted/bounded names, soft failure of name lookup, and parameterized/bounded queries. Production build and lint on changed files passed. The Chrome smoke test also passed using a real temporary API key: its name appears in both list and Detail, owner credentials list only their own history without exposing the key value, deleting the key retains the history with a deleted-key label, and the deleted credential loses access. No live inference was used for these checks.
