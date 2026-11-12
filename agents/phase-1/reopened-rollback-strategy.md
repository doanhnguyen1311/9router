# Reopened Phase 1 rollback strategy

## Application rollback

Revert implementation checkpoint `11af71e8a94529c9c38375d8e1ab005ddad0a6c6`. This removes request interception, session polling and the migration registration from the running application. Existing inference behavior then returns to the pre-reopen checkpoint `22c4bfc3cb629969e8a6604733d03703a9b4a34a`.

Before rollback, set affected API Keys to Planning `OFF` if a mixed-version deployment is possible.

## Database rollback

The new table is additive. Safest rollback is to leave `planningRequestBindings` unused while older application code runs. Do not drop it on a live database merely to lower the schema number.

If a full database rollback is required, stop writers and restore the verified automatic schema 18→19 backup according to the existing database recovery procedure. This discards Plans/request bindings created after the backup and therefore requires explicit operator confirmation.

## Validation after rollback

- Old API Keys return the original inference format.
- Provider routing/SSE/Ollama/Gemini regressions pass.
- `PRAGMA foreign_key_check` is empty.
- No Planning-enabled key is left expecting a `202` session protocol from an older server.
