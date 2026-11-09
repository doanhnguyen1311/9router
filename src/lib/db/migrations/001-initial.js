// Initial schema bootstrap. For fresh DB this creates all tables/indexes.
// For existing DB at version 0 (legacy unstamped), it's idempotent (IF NOT EXISTS).
import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 1,
  name: "initial",
  up(db) {
    for (const [name, def] of Object.entries(TABLES)) {
      db.exec(buildCreateTableSql(name, def));
      // A legacy, unstamped database may already have an older version of a
      // table. Some current indexes reference columns that are intentionally
      // added by later migrations/additive sync, so defer those indexes until
      // their columns exist instead of aborting the whole migration chain.
      for (const idx of def.indexes || []) {
        try { db.exec(idx); } catch { /* additive sync retries after columns */ }
      }
    }
  },
};
