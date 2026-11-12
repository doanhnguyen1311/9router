# Reopened Phase 3 performance assessment

## Local control plane

Twenty create/ticket/claim/cancel iterations completed with:

- Average ticket/claim/cancel latency: `1.79 ms`
- p95: `3.67 ms`
- Required p95 bound: `< 500 ms` — PASS

These are local SQLite/control-plane measurements and do not represent provider/network latency.

## Real Codex integration smoke

An isolated temporary Git repository was executed with installed `codex-cli 0.165.0` and the final hardened flags. It completed in `21,890 ms`, created only the approved file and reported:

- Input tokens: `63,100`
- Cached input tokens: `55,936`
- Cache-write tokens: `0`
- Output tokens: `378`
- Reasoning-output tokens: `39`

This proves the handoff reaches a real Codex process. It is not evidence that Planning saves tokens.

## Comparative token benchmark

The required Baseline A / Variant B / Variant C comparison remains `NOT TESTED`. There is no frozen task corpus with equivalent repository revisions, provider/model settings, billing telemetry and success criteria. No token- or cost-saving claim is made.

A valid future run must compare direct Codex, Planning → Approval → Codex and Planning + cached context → Codex over the same tasks, recording planner/Codex/cached tokens, cost, latency, tools/files read, test pass rate, completion and rework.
