# Phase 2 rollback strategy

1. Stop at the Phase 2 implementation checkpoint before enabling Planning on any API key.
2. Revert the Phase 2 application commit(s) if the dashboard/API behavior must be removed.
3. Keep the additive schema migration and data unless a reviewed database rollback is explicitly required; OFF defaults make the old request path safe while records remain recoverable.
4. If schema recovery is required, use the automatic `schema-15-to-16-*` pre-migration backup and restore only through the existing database recovery procedure. Do not drop tables or reset the database.
5. `AGENTS.md` is user-owned and remains untracked/excluded from any checkpoint.
