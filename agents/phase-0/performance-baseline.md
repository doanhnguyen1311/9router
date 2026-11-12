# Phase 0 performance baseline

Environment: Node `v22.23.2`, Linux x64, `better-sqlite3`, local temporary databases. Development-host measurements only.

## Project Memory and file intelligence

- Seed 2,000 memories: `1,186.12 ms`.
- Seed 300 graph entities: `12.08 ms`.
- Index 50 files: `312.73 ms` (`159.88 files/s`).
- Memory retrieval (100): `6.36 ms` average, `8.39 ms` p95, 1,349 estimated context tokens.
- Graph traversal (100): `0.56 ms` average, `0.63 ms` p95.
- Queue 200 jobs: `795.87 ms` (`251.30 jobs/s`).
- 50 concurrent retrievals: `504.76 ms`; 50 concurrent writes: `228.30 ms`.
- ZIP first import: `246.24 ms`; incremental unchanged import: `5.38 ms`.

## HTTP health

- 100 sequential: `5.85 ms` average, `11.42 ms` p95.
- 50 concurrent: `175.04 ms` wall, `163.35 ms` p95, `285.65 req/s` observed.
- Server snapshot: approximately `146,552 KiB` RSS.

## SQLite vs legacy JSON microbenchmark

- Insert 500 connections: SQLite `120.10 ms`, JSON `1,243.58 ms` — 10.35× faster.
- 200 filtered reads: SQLite `33.09 ms`, JSON `227.25 ms` — 6.87× faster.
- 200 point lookups: SQLite `1.51 ms`, JSON `197.83 ms` — 130.67× faster.
- Save 500 usage entries: SQLite `325.44 ms`, JSON `1,435.08 ms` — 4.41× faster.
- Aggregate 24h usage 50×: SQLite `407.60 ms`, JSON `83.29 ms` — SQLite measured 0.20× JSON performance. This is the primary database performance watch item for later phases.

## NOT TESTED

- Real LLM/SSE first-token/end-to-end latency and provider rate-limit concurrency.
- Sustained CPU/memory leak behavior, multi-process queue throughput, and production storage.

Phase 1 must compare its context retrieval/database paths against these values and investigate material regressions.
