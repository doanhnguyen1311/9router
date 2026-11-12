# Phase 0 baseline test report

## Final quality-gate summary

| Check | Result | Evidence |
|---|---:|---|
| Full Vitest gate | PASS | 1,427 suites; 4,775 tests; 4,643 pass; 0 fail; 131 conditional pending; 1 todo |
| Root production build | PASS | 157 routes/pages; isolated temporary `DATA_DIR` |
| CLI package build | PASS | Next standalone, assets, MITM bundle, SQLite packaging |
| ESLint | PASS | 0 errors; 269 warnings |
| Production dependency audit | PASS | root 0; CLI 0 vulnerabilities |
| Typecheck | PASS/PARTIAL | Next build TypeScript step passed; no standalone command |
| Migration/restart/import | PASS | migration 4 plus existing chain and additive sync |
| API-key/security focused | PASS | plaintext-at-rest/response regression covered |
| Project CSRF/RBAC/isolation | PASS | same-origin negative test and existing permission suites |
| Live external providers | NOT TESTED | opt-in only; no production credentials used |
| Optional Cloudflare checkout | NOT TESTED | `cloud/` source absent |

Raw final evidence:

- `quality-gate-vitest-report.json`
- `final-eslint-report.json`
- `project-db-test-report.json`
- `api-key-security-test-report.json`
- `codex-routing-stream-test-report.json`

## Remediation notes

- Updated stale test contracts only where the source behavior was intentional and strengthened assertions around isolation, replay, transport ownership, schema cleanup, and secret handling.
- Fixed real defects in usage-key storage/serialization, Headroom safety ordering compatibility, text-array/NDJSON normalization, Cursor optional-driver loading, Project same-origin enforcement, and build isolation.
- Missing optional/live sources are conditionally skipped with explicit labels; no failing assertion was silently removed.
- Golden snapshots now include current provider registry entries while normalizing only runtime/app-version/UUID fields.

The initial failing run is retained as `vitest-report.json` and `eslint-report.json` for before/after comparison.
