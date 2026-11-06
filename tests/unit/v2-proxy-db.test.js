import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalApiKeySecret = process.env.API_KEY_SECRET;

async function boot() {
  delete global._dbAdapter;
  vi.resetModules();
  const database = await import("@/lib/db/index.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  return { database, adapter: await getAdapter() };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-v2-proxy-"));
  process.env.DATA_DIR = tempDir;
  process.env.API_KEY_SECRET = "v2-test-encryption-secret";
});

afterEach(() => {
  global._dbAdapter?.instance?.close();
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalApiKeySecret === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = originalApiKeySecret;
});

describe("v2 proxy API-key persistence", () => {
  it("encrypts the upstream key and exposes only enabled/configured metadata", async () => {
    const { database, adapter } = await boot();
    const created = await database.createApiKey("V2 customer", "machine-a", undefined, {
      enabled: true,
      upstreamBaseUrl: "https://upstream.example/v1/",
      upstreamApiKey: "upstream-secret-value",
    });

    expect(created.v2Proxy).toEqual({ enabled: true, configured: true });
    const raw = adapter.get("SELECT * FROM apiKeys WHERE id = ?", [created.id]);
    expect(raw.v2UpstreamBaseUrl).toBe("https://upstream.example/v1");
    expect(raw.v2UpstreamApiKeyEncrypted).not.toContain("upstream-secret-value");
    expect(raw.v2UpstreamApiKeyEncrypted).toMatch(/^v2e1\./);

    const listed = await database.getApiKeys();
    expect(listed[0].v2Proxy).toEqual({ enabled: true, configured: true });
    expect(JSON.stringify(listed)).not.toContain("upstream.example");
    expect(JSON.stringify(listed)).not.toContain("upstream-secret-value");

    const serverOnly = await database.getV2ProxyConfigByKey(created.key);
    expect(serverOnly.config).toEqual({
      upstreamBaseUrl: "https://upstream.example/v1",
      upstreamApiKey: "upstream-secret-value",
    });
  });

  it("round-trips encrypted v2 config through backups without plaintext credentials", async () => {
    const { database } = await boot();
    const created = await database.createApiKey("Backup", "machine-b", undefined, {
      enabled: true,
      upstreamBaseUrl: "https://backup-upstream.example/v1",
      upstreamApiKey: "backup-upstream-secret",
    });
    const backup = await database.exportDb();
    expect(JSON.stringify(backup)).not.toContain("backup-upstream-secret");

    await database.importDb(backup);
    expect((await database.getV2ProxyConfigByKey(created.key)).config.upstreamApiKey)
      .toBe("backup-upstream-secret");
  });

  it("adds disabled v2 columns to an existing database without losing rows", async () => {
    fs.mkdirSync(path.join(tempDir, "db"), { recursive: true });
    const sqlite = new DatabaseSync(path.join(tempDir, "db", "data.sqlite"));
    for (const [name, definition] of Object.entries(TABLES)) {
      const def = { ...definition, columns: { ...definition.columns } };
      if (name === "apiKeys") {
        delete def.columns.v2Enabled;
        delete def.columns.v2UpstreamBaseUrl;
        delete def.columns.v2UpstreamApiKeyEncrypted;
      }
      sqlite.exec(buildCreateTableSql(name, def));
    }
    sqlite.exec(`
      INSERT INTO _meta(key, value) VALUES ('schemaVersion', '1'), ('backupSchemaVersion', '10');
      INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt)
      VALUES ('legacy', 'sk-legacy', 'Legacy', 'machine', 1, '2026-01-01T00:00:00.000Z');
    `);
    sqlite.close();

    const { database, adapter } = await boot();
    const columns = adapter.all("PRAGMA table_info(apiKeys)").map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      "v2Enabled",
      "v2UpstreamBaseUrl",
      "v2UpstreamApiKeyEncrypted",
    ]));
    expect((await database.getApiKeyById("legacy")).v2Proxy).toEqual({ enabled: false, configured: false });
    expect(fs.readdirSync(path.join(tempDir, "db", "backups"))
      .some((name) => name.startsWith(`schema-10-to-${SCHEMA_VERSION}`))).toBe(true);
  });
});
