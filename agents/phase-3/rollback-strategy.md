# Phase 3 rollback strategy

Application rollback is performed by reverting checkpoint `48fee22c` and disabling worker processes/endpoints. The schema change is additive, so older application code ignores `planExecutions`; do not drop the table as an automatic rollback.

Before any reviewed database restore, stop writers and retain the current database for audit. Use the automatic schema 16→17 backup only if data-level rollback is explicitly required, then verify foreign keys and application startup. Rotate the worker and ticket secrets if compromise, rather than deleting execution history.

Queued/running executions should be cancelled or allowed to reach a recorded terminal state before application rollback. Never retry a partially completed Codex operation solely because its lease expired.
