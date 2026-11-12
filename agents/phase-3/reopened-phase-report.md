# Reopened mandatory phase report

**Phase:** 3 — Corrected automatic Codex execution handoff

**Implementation Status:** COMPLETED

**Quality Gate:** PASS

**Starting checkpoint:** `96c06296`

**Implementation checkpoint:** `138905ed`

## Features completed

- API-Key planning sessions expose explicit `prepare_execution` and `cancel_execution` actions after human approval.
- New `9router execute-plan` command snapshots the local Git workspace, obtains a one-time scoped ticket, claims it as an authenticated worker, invokes the installed Codex CLI and returns the verified result to the same planning session.
- Dashboard displays the local command, polls queued/running execution state, shows filtered results and supports authorized cancellation.
- Workspace validation now detects branch, commit, relevant-file and full dirty-tree drift, including changed content that retains the same Git status.
- Secret files, unsafe symlinks, path escape, oversized scans and unbounded untracked content fail closed before Codex starts.
- Codex runs with `workspace-write`, ephemeral/ignored user configuration and rules, approval policy `never`, a restricted inherited environment and no dangerous sandbox bypass.
- Public execution DTOs exclude ticket hashes/IDs, source workspace descriptors, leases and heartbeats. Logs, structured results and usage are bounded and sanitized.

## Files changed

- `cli/cli.js`
- `cli/src/cli/commands/executePlan.js`
- `src/app/(dashboard)/dashboard/projects/[id]/ProjectPlanningPanel.jsx`
- Planning-session and plan/execution API routes under `src/app/api/v1/`
- `src/lib/execution/{codexCli,constants,repository,service,workspace}.js`
- `src/lib/planning/orchestration.js`
- Phase-specific unit and integration tests

## Database changes

No schema or migration was added in the reopened phase. The implementation reuses durable `planExecutions` storage from migration 007 and the automatic planning association from migration 009. Fresh migration 1–9 and the production build both passed.

## Testing

- Authoritative capped-worker regression: 1,466/1,466 suites; 4,704 passed; 0 failed; 131 conditional pending; 1 todo.
- Focused Phase 3: 3 files / 19 tests passed.
- Production build and TypeScript: PASS; 163/163 routes/pages generated.
- Focused ESLint: 15 files, 0 errors, 0 warnings. Repository ESLint: 0 errors, 269 baseline warnings.
- `npm audit --omit=dev`: 0 vulnerabilities. `git diff --check`: PASS.
- Real Codex CLI 0.165.0 smoke execution in an isolated temporary Git repository: PASS.

## Security

Critical findings: 0. High findings: 0. Residual Medium operational items are documented in `reopened-security-review.md`.

## Git checkpoint

`138905ed` — `feat: connect approved plans to local codex execution`. The user-owned untracked root `AGENTS.md` was excluded.

## Rollback

Revert `138905ed`, stop local execution workers and retain existing execution audit rows. No schema rollback is required.

## Next phase

Phase 4 automated regression remains compatible, but its Quality Gate remains `BLOCKED` until a supported real ChatGPT Web session can be paired with reachable non-production HTTPS and prove correct Project isolation end to end.
