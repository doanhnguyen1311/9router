# Reopened Phase 2 test report

## Full regression

Evidence: [`reopened-final-quality-gate-vitest-report.json`](./reopened-final-quality-gate-vitest-report.json).

- Result: PASS.
- Suites: 1,461 passed / 1,461 total.
- Tests: 4,827 total; 4,695 passed; 0 failed; 131 pending/skipped; 1 todo.

## Focused verification

- 12 Planning/API/RBAC/dashboard-guard/provider/performance files: 66/66 passed.
- Final action/provider pipeline files: 3/3 passed.
- Action tests cover exact-key isolation, strict fields, stale versions, current-version details, concurrent approval, mandatory approval, CORS and 120-write rate limiting.
- Integration test uses a real isolated HTTP Planning upstream and completes request → revise → select → request approval → approve, while the requested execution model remains nonexistent.
- Existing approval tests cover viewer denial, invalid scope/option, cross-Plan replay and rejection.

## Build, lint and dependencies

- Production build: PASS; compile 61 s, TypeScript PASS, isolated DB migration PASS, 163/163 pages, standalone assets copied.
- Action route appears in the Next production route manifest.
- Full ESLint: [`reopened-final-eslint-report.json`](./reopened-final-eslint-report.json), 3,472 files, 0 errors/0 fatal, 269 warnings.
- `npm audit --omit=dev`: 0 vulnerabilities across 651 dependencies.
- `git diff --check`: PASS.

Non-failing baseline warnings remained limited to SQLite experimental, in-process listener count, typeless-module and chat-history test warnings.
