# Phase 3 performance assessment

## Measured

Twenty local ticket/claim/cancel control-plane iterations completed with:

- Average: `3.64 ms`
- p95: `5.61 ms`

A real Codex CLI 0.165.0 smoke task ran in an isolated temporary Git repository and wrote the requested file successfully. The emitted usage event reported 50,116 input tokens, 39,168 cached input tokens, 184 output tokens and 18 reasoning-output tokens. This is integration evidence, not a comparative cost claim.

## A/B/C token benchmark

`NOT TESTED` for the required comparison of direct Codex, Planning → Approval → Codex, and Planning + cached context → Codex. The repository does not contain a controlled task corpus with repeatable planner/provider billing telemetry. Fabricating results would invalidate the comparison.

No claim is made that Planning saves total tokens. A future benchmark must freeze repository revisions, tasks, models, provider settings and success criteria, then record planner/Codex/cached tokens, cost, latency, files read, tool calls, pass rate and rework rate for all three variants.
