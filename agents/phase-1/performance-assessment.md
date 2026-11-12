# Phase 1 performance assessment

Environment: Node `v22.23.2`, Linux x64, `better-sqlite3`, isolated temporary databases. Development-host measurements only.

## Planning persistence benchmark

Thirty complete local planning persistence flows with an in-process deterministic provider:

- Create average: `2.79 ms`.
- Create p95: `6.58 ms`.
- List 30 plans: `0.88 ms`.
- Read 30 plans concurrently: `3.42 ms`.
- Foreign-key violations: `0`.

## Project context regression comparison

Latest representative Project Memory run after symbol retrieval was added:

- Retrieval average: `6.63 ms` versus Phase 0 `6.36 ms` (about +4.2%).
- Retrieval p95: `7.56 ms` versus Phase 0 `8.39 ms` (about -9.9%).
- 50 concurrent retrievals: `316.23 ms` versus Phase 0 `504.76 ms`.
- Index 50 files: `199.23 ms` versus Phase 0 `312.73 ms`.

These local results show no material Phase 1 regression. Host cache/scheduler variance means they are directional, not a production SLO.

## Provider path

The production router adapter completed against an isolated local HTTP provider and preserved usage accounting/cancellation. Real remote-provider latency, cost, rate limits and sustained production resource behavior were not measured because doing so would require external credentials and Project-data disclosure. Those measurements are not needed to establish Phase 1 functional correctness and remain an explicit deployment benchmark item.
