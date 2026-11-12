// Verify schema migration chain runs correctly across versions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mig-"));
  process.env.DATA_DIR = tempDir;
  // Reset global singleton so each test gets fresh adapter pointed at tempDir
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  // Close adapter to release file handles before rm
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Schema migrations", () => {
  it("fresh DB → applies migrations & stamps schemaVersion", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db = await getAdapter();
    const row = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      "_meta", "settings", "providerConnections", "providerNodes",
      "proxyPools", "apiKeys", "combos", "kv", "usageHistory", "usageDaily", "requestDetails",
    ]));
  });

  it("existing DB at older schemaVersion → re-applies pending migrations on restart", async () => {
    // 1st boot
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, ['{"foo":"bar"}']);
    db.run(`UPDATE _meta SET value = '0' WHERE key = 'schemaVersion'`);
    db.close?.();

    // 2nd boot: full reset to simulate process restart
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db2 = await getAdapter2();
    const row = db2.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const settings = db2.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "bar" });
  });

  it("fresh DB + legacy db.json → imports data automatically", async () => {
    // Simulate user upgrading: place legacy JSON in DATA_DIR before first boot
    const legacy = {
      settings: { foo: "legacy-value" },
      apiKeys: [{ id: "k1", key: "abc", name: "test", createdAt: new Date().toISOString() }],
      modelAliases: { "gpt-4": "gpt-4-turbo" },
    };
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify(legacy));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const settings = db.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "legacy-value" });

    const keys = db.all(`SELECT * FROM apiKeys`);
    expect(keys).toHaveLength(1);
    expect(keys[0].key).not.toBe("abc");
    expect(keys[0].keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(keys[0].keyEncrypted).not.toContain("abc");
    const { getApiKeyByKey } = await import("@/lib/db/index.js");
    expect(await getApiKeyByKey("abc")).toMatchObject({ id: "k1", key: "abc" });

    const aliases = db.all(`SELECT * FROM kv WHERE scope='modelAliases'`);
    expect(aliases).toHaveLength(1);
  });

  it("migration v3 preserves duplicate projects by renaming later rows before adding the unique key", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const migration = (await import("@/lib/db/migrations/003-project-constraints.js")).default;
    const db = await getAdapter();
    db.exec("DROP INDEX IF EXISTS idx_projects_name_key_unique");
    db.run("DELETE FROM projects");
    const longName = `Duplicate ${"x".repeat(110)}`;
    db.run(
      "INSERT INTO projects(id, ownerId, name, nameKey, description, status, version, createdAt, updatedAt, lastActivityAt) VALUES(?, ?, ?, NULL, '', 'active', 1, ?, ?, ?)",
      ["older", "owner:a", `  ${longName}  `, "2025-01-01", "2025-01-01", "2025-01-01"],
    );
    db.run(
      "INSERT INTO projects(id, ownerId, name, nameKey, description, status, version, createdAt, updatedAt, lastActivityAt) VALUES(?, ?, ?, NULL, '', 'active', 1, ?, ?, ?)",
      ["newer", "owner:b", longName.toUpperCase(), "2025-01-02", "2025-01-02", "2025-01-02"],
    );

    migration.up(db);

    const rows = db.all("SELECT id, name, nameKey FROM projects ORDER BY createdAt");
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe(longName);
    expect(rows[1].name).toMatch(/ \(2\)$/);
    expect(rows[1].name.length).toBeLessThanOrEqual(120);
    expect(rows[0].nameKey).not.toBe(rows[1].nameKey);
    expect(db.all("PRAGMA index_list(projects)").map((index) => index.name)).toContain("idx_projects_name_key_unique");
  });

  it("auto-sync re-creates missing index when DB lacks it", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.exec(`DROP INDEX IF EXISTS idx_pn_type`);
    expect(db.all(`PRAGMA index_list(providerNodes)`).map(i => i.name)).not.toContain("idx_pn_type");
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    const idx = db2.all(`PRAGMA index_list(providerNodes)`).map(i => i.name);
    expect(idx).toContain("idx_pn_type");
  });

  it("migration v4 removes plaintext API keys from usage history and daily rollups", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const rawKey = "sk-migration-secret-12345678";
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens)
       VALUES(?, 'openai', 'gpt-4', ?, 1, 2)`,
      [new Date().toISOString(), rawKey],
    );
    db.run(
      "INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES('2026-11-12', ?)",
      [JSON.stringify({ byApiKey: { [`${rawKey}|gpt-4|openai`]: { requests: 1, rawModel: "gpt-4", provider: "openai", apiKey: rawKey } } })],
    );
    db.run("UPDATE _meta SET value='3' WHERE key='schemaVersion'");
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: reopen } = await import("@/lib/db/driver.js");
    const migrated = await reopen();
    const historyKey = migrated.get("SELECT apiKey FROM usageHistory LIMIT 1").apiKey;
    const daily = migrated.get("SELECT data FROM usageDaily WHERE dateKey='2026-11-12'").data;

    expect(historyKey).toMatch(/^h1:[a-f0-9]{64}$/);
    expect(historyKey).not.toContain(rawKey);
    expect(daily).not.toContain(rawKey);
    expect(daily).toContain("sk-migra***5678");
  });
});
