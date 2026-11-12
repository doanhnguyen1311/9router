# Phase 1 test report

## Final regression

Command: `npx vitest run --config tests/vitest.config.js --reporter=json --outputFile=agents/phase-1/final-quality-gate-vitest-report.json`

- Test suites: 1,436 total, 1,436 passed, 0 failed.
- Tests: 4,787 total, 4,655 passed, 0 failed, 131 conditional pending/skipped, 1 existing todo.
- Machine evidence: [`final-quality-gate-vitest-report.json`](./final-quality-gate-vitest-report.json).

The conditional tests require optional credentials/services/fixtures and are not Phase 1 acceptance tests. The final report contains no failed mandatory test.

## Phase 1 coverage

- Strict structured-plan schema, extra-field rejection and secret redaction.
- Invalid LLM output retry, bounded timeout, caller cancellation and usage accounting.
- End-to-end production router adapter against an isolated local OpenAI-compatible HTTP server; no Internet or production data used.
- Bounded context with memory/file/symbol/dependency/graph provenance and cross-project isolation.
- Create, clarification, options, feedback, revisions, selection, approval request, cancellation and expiration state behavior.
- Owner/editor mutation, viewer read-only restriction and cross-project plan isolation.
- Concurrent selection and concurrent revision: one version wins and the stale request receives conflict.
- SQLite restart recovery, export/import, lightweight backup and cyclic selected-option FK verification.
- Versioned API integration and cross-origin mutation rejection.
- Planning provider failure persistence without a fake successful revision.

## Build and static checks

- `npm run build`: PASS; Next.js compiled, type analysis completed, 158 pages generated, and all Planning routes were registered.
- Full ESLint: 3,419 files, 0 errors, 269 baseline warnings, exit 0. Evidence: [`final-eslint-report.json`](./final-eslint-report.json).
- No standalone typecheck script exists; Next.js build's TypeScript stage passed.

## Fix/retest evidence

- Initial full run found the lightweight backup copying a forward FK before the referenced table existed. Backup/import now create/defer the full FK graph; focused and full regression passed.
- A later full run exposed a pre-existing chat-history readiness race under load. The worker now acknowledges completion of initial configuration/cleanup before the service becomes ready. The affected suite passed five consecutive isolated runs and the final full regression.
