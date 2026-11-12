# Reopened Phase 1 test report

## Full regression

Final root-corrected Vitest report: [`reopened-final-quality-gate-vitest-report.json`](./reopened-final-quality-gate-vitest-report.json).

- Result: PASS.
- Suites: 1,459 passed / 1,459 total.
- Tests: 4,822 total; 4,690 passed; 0 failed; 131 pending/skipped; 1 todo.

An initial run from `tests/` produced three suite-load `ENOENT` errors in cwd-sensitive legacy tests while all loaded assertions passed. Each was rerun from repository root and passed 33/33, then the entire root-corrected suite passed. The diagnostic report is retained as [`reopened-quality-gate-vitest-report.json`](./reopened-quality-gate-vitest-report.json); it is not treated as product failure evidence.

## New focused coverage

- `tests/unit/planning-orchestration.test.js`: ADAPTIVE interception, multi-option response, idempotency, hashed bindings, export/import, MANUAL signal, OFF bypass protection, format extraction, tool continuation, failure policy and cross-key isolation.
- `tests/integration/planning-request-pipeline.test.js`: real local Planning upstream plus a nonexistent requested execution model; OpenAI, Ollama and Gemini all returned the same planning session.
- Final post-review run: 2 files / 7 tests passed.

## Build, lint and dependency checks

- `npm run build`: PASS; compile and TypeScript checks completed; migration 009 applied on the isolated build database; 163/163 pages generated.
- Full ESLint report: [`reopened-final-eslint-report.json`](./reopened-final-eslint-report.json), 3,470 files, 0 errors, 0 fatal, 269 warnings.
- Focused ESLint after the last review patch: PASS with no output.
- `npm audit --omit=dev --json`: 0 production vulnerabilities.
- `git diff --check`: PASS.

Observed non-failing warnings: Node SQLite experimental warning, listener-count warnings in repeated in-process DB boots, typeless-module warning and an existing chat-history storage warning.
