// Project Memory schema is declared in schema.js so fresh databases and the
// additive synchronizer share one source of truth. This migration exists to
// backfill ownership for pre-existing API keys and seed the global feature row.
import { TABLES, buildCreateTableSql } from "../schema.js";
import { isProtectedApiKeyRow, protectApiKey } from "@/lib/apiKeyStorage.js";

const PROJECT_TABLES = [
  "projectSystemSettings", "projectPermissions", "projects", "projectMembers",
  "projectApiKeys", "projectSettings", "projectSessions", "memoryEvents",
  "extractionJobs", "memoryItems", "memoryItemHistory", "memoryEntities",
  "memoryRelations", "projectFiles", "projectSymbols", "projectFileDependencies",
  "contextSnapshots", "memoryUsage",
];

export default {
  version: 2,
  name: "project-memory-engine",
  up(db) {
    const apiKeyColumns = new Set(db.all("PRAGMA table_info(apiKeys)").map((row) => row.name));
    if (!apiKeyColumns.has("ownerId")) db.exec("ALTER TABLE apiKeys ADD COLUMN ownerId TEXT DEFAULT 'local-admin'");
    if (!apiKeyColumns.has("projectAccess")) db.exec("ALTER TABLE apiKeys ADD COLUMN projectAccess INTEGER NOT NULL DEFAULT 1");
    if (!apiKeyColumns.has("keyHash")) db.exec("ALTER TABLE apiKeys ADD COLUMN keyHash TEXT");
    if (!apiKeyColumns.has("keyEncrypted")) db.exec("ALTER TABLE apiKeys ADD COLUMN keyEncrypted TEXT");
    for (const row of db.all("SELECT id, key, keyHash, keyEncrypted, machineId FROM apiKeys")) {
      if (isProtectedApiKeyRow(row)) continue;
      const protectedKey = protectApiKey(row.key, row.machineId);
      db.run("UPDATE apiKeys SET key=?, keyHash=?, keyEncrypted=? WHERE id=?", [protectedKey.storageKey, protectedKey.keyHash, protectedKey.keyEncrypted, row.id]);
    }
    db.exec("UPDATE apiKeys SET ownerId = 'local-admin' WHERE ownerId IS NULL OR ownerId = ''");

    for (const name of PROJECT_TABLES) {
      const def = TABLES[name];
      db.exec(buildCreateTableSql(name, def));
      for (const index of def.indexes || []) {
        try { db.exec(index); } catch { /* later migrations may add referenced columns */ }
      }
    }
    // FTS5 is optional at the driver level (not every sql.js build includes
    // it). The relational search path remains fully functional when this DDL
    // is unavailable.
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS projectSearch USING fts5(
        projectId UNINDEXED, kind UNINDEXED, refId UNINDEXED, title, body,
        tokenize='unicode61 remove_diacritics 2'
      )`);
    } catch { /* relational fallback */ }
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO projectSystemSettings(
        id, enabled, defaultUserAccess, extractionEnabled, retrievalEnabled,
        fileIndexingEnabled, maxProjectsPerUser, maxFilesPerProject,
        maxProjectBytes, maxFileBytes, updatedAt
      ) VALUES(1, 1, 1, 1, 1, 1, 50, 5000, 268435456, 10485760, ?)`,
      [now],
    );
  },
  // The migration runner intentionally never calls down automatically. Keeping
  // this explicit makes controlled development rollback auditable.
  down(db) {
    try { db.exec("DROP TABLE IF EXISTS projectSearch"); } catch { /* optional */ }
    for (const name of [...PROJECT_TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${name}`);
  },
};
