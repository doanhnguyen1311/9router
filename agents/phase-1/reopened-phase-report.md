# Mandatory phase report — reopened Phase 1

**Phase:** 1 — Automatic Planning Foundation

**Implementation Status:** COMPLETED

**Quality Gate:** PASS

**Features Completed:**

- `ADAPTIVE` API Keys automatically intercept a new user inference request before execution-provider routing.
- `MANUAL` requires `X-9Router-Planning: plan`; `OFF`, disabled and legacy keys stay on the historical path.
- OpenAI Chat/Responses, Claude-compatible, Gemini and Ollama entry points expose one `202 Accepted` planning-session envelope.
- Real Project context and the configured API-callable Planning Provider generate structured intent and multiple options.
- Tool-only continuations are not mistaken for new planning requests.
- API-key-scoped idempotency prevents duplicate planning cost and duplicate Plans without storing the plaintext idempotency key.
- The originating API Key can poll its own session; another key receives `404` even inside the same Project.
- Security/configuration failures fail closed. Provider transient failures follow the administrator's explicit `FAIL_CLOSED`/`LEGACY_PATH` policy.

**Files Changed:**

- `src/lib/planning/orchestration.js`: request classification, session serialization, API-key ownership and failure policy.
- `src/sse/handlers/chat.js`: planning gate before Project Memory augmentation and execution routing.
- `src/app/api/v1/planning/sessions/[planId]/route.js`: API-key-owned session read endpoint.
- Gemini/Ollama adapters: preserve the planning control-plane envelope.
- Planning service/repository and DB export/import: durable request-to-Plan binding.
- Migration 009/schema 19, unit/integration tests and Phase evidence.

**Database Changes:**

- Application schema `18 → 19`; migration `009-automatic-planning-orchestration`.
- Added `planningRequestBindings` with Plan/Project/API-Key foreign keys and unique `(apiKeyId, requestKeyHash)` replay protection.
- Additive migration, export/import round trip and `PRAGMA foreign_key_check` passed.

**Testing:**

- Full regression: 1,459/1,459 suites passed; 4,690 passed, 0 failed, 131 conditional pending/skipped and 1 todo out of 4,822 tests.
- Post-review focused orchestration/pipeline: 7/7 passed, including the `OFF` header-bypass regression.
- Production build: PASS, TypeScript PASS, 163/163 static pages generated.
- ESLint: 3,470 files, 0 errors/0 fatal; 269 non-blocking warnings. Post-review focused lint: clean.
- Production dependency audit: 0 vulnerabilities.

**Security:**

- Open Critical/High findings: 0/0.
- Exact API Key and Project binding, bounded input, redacted Project context, no-store responses and hashed replay keys verified.
- The requested execution model was deliberately nonexistent in integration testing; the successful `202` proves it was never contacted.

**Performance:**

- 30 Plan creates averaged `2.13 ms`, p95 `5.64 ms`; list `0.72 ms`; concurrent reads `4.32 ms` on isolated local SQLite.
- Remote Planning Provider latency/cost was not benchmarked and no token-savings claim is made.

**Git Checkpoint:** `11af71e8a94529c9c38375d8e1ab005ddad0a6c6` (`feat: orchestrate automatic planning requests`). User-owned `AGENTS.md` remained untracked.

**Rollback:** Revert the application checkpoint. The additive table may remain unused, or restore the automatic schema 18→19 backup when database rollback is necessary.

**Next Phase:** Reopened Phase 2 is READY. Phase 3 remains locked until the new select/revise/approve protocol passes its gate.
