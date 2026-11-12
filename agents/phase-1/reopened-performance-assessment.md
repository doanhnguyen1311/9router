# Reopened Phase 1 performance assessment

## Local SQLite benchmark

Environment: isolated temporary SQLite database, 30 Plans.

| Operation | Result |
| --- | ---: |
| Create average | 2.13 ms |
| Create p95 | 5.64 ms |
| List 30 Plans | 0.72 ms |
| Concurrent reads | 4.32 ms |

Earlier Phase 1 reference: create average `2.79 ms`, p95 `6.58 ms`. The additive binding transaction introduced no measurable persistence regression in this run.

## Request-path assessment

- `OFF` and legacy keys add one in-memory decision check after existing access/quota resolution; no Project context or Planning Provider is called.
- `ADAPTIVE` deliberately exchanges model-response latency for a Planning Provider call and a durable approval workflow.
- Idempotent retry returns the existing Plan before provider validation/context retrieval, avoiding repeat provider cost.
- Extraction is bounded to the configured original-request character limit.

Remote provider latency, planner token cost and end-to-end token savings are `NOT TESTED` in Phase 1. Those claims remain reserved for the controlled Phase 3 benchmark.
