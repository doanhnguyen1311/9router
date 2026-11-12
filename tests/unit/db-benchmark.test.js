// Benchmark: SQLite vs the legacy JSON-file persistence shape on equivalent workloads.
// Run: cd app/tests && npm test -- db-benchmark
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeAll, afterAll, vi } from "vitest";

const N_ITEMS = 500;
const N_QUERIES = 200;

const originalDataDir = process.env.DATA_DIR;
let tempSqlite, tempLegacy;
let sqliteDb, legacyDbFile, legacyData;

function fmt(ms) { return `${ms.toFixed(2)}ms`; }

function readLegacy() {
  legacyData = JSON.parse(fs.readFileSync(legacyDbFile, "utf8"));
}

function writeLegacy() {
  fs.writeFileSync(legacyDbFile, JSON.stringify(legacyData));
}

async function bench(label, fn) {
  // warmup
  await fn();
  const t0 = performance.now();
  await fn();
  const dt = performance.now() - t0;
  console.log(`  ${label.padEnd(40)} ${fmt(dt)}`);
  return dt;
}

beforeAll(async () => {
  // SQLite setup
  tempSqlite = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bench-sqlite-"));
  process.env.DATA_DIR = tempSqlite;
  vi.resetModules();
  sqliteDb = await import("@/lib/db/index.js");
  await sqliteDb.initDb();

  // Legacy baseline without depending on the removed lowdb package.
  tempLegacy = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bench-json-"));
  legacyDbFile = path.join(tempLegacy, "db.json");
  legacyData = { providerConnections: [], usageHistory: [] };
  writeLegacy();
});

afterAll(() => {
  if (tempSqlite) fs.rmSync(tempSqlite, { recursive: true, force: true });
  if (tempLegacy) fs.rmSync(tempLegacy, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("DB Benchmark — SQLite vs legacy JSON file", () => {
  it(`INSERT ${N_ITEMS} provider connections`, async () => {
    console.log(`\n[INSERT ${N_ITEMS}]`);

    const sqliteTime = await bench("SQLite createProviderConnection", async () => {
      for (let i = 0; i < N_ITEMS; i++) {
        await sqliteDb.createProviderConnection({
          provider: `bench-p${i % 5}`, authType: "apikey",
          name: `name-${i}`, apiKey: `k-${i}`,
        });
      }
    });

    const legacyTime = await bench("Legacy JSON push + write", async () => {
      for (let i = 0; i < N_ITEMS; i++) {
        legacyData.providerConnections.push({
          id: `id-${i}`, provider: `bench-p${i % 5}`, authType: "apikey",
          name: `name-${i}`, apiKey: `k-${i}`, priority: i + 1, isActive: true,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        writeLegacy();
      }
    });

    const speedup = (legacyTime / sqliteTime).toFixed(2);
    console.log(`  → SQLite is ${speedup}x faster`);
  }, 60000);

  it(`READ ${N_QUERIES} filtered queries`, async () => {
    console.log(`\n[READ ${N_QUERIES} filtered queries]`);

    const sqliteTime = await bench("SQLite getProviderConnections(filter)", async () => {
      for (let i = 0; i < N_QUERIES; i++) {
        await sqliteDb.getProviderConnections({ provider: `bench-p${i % 5}` });
      }
    });

    const legacyTime = await bench("Legacy JSON read + filter", async () => {
      for (let i = 0; i < N_QUERIES; i++) {
        readLegacy();
        legacyData.providerConnections.filter((c) => c.provider === `bench-p${i % 5}`);
      }
    });

    const speedup = (legacyTime / sqliteTime).toFixed(2);
    console.log(`  → SQLite is ${speedup}x faster`);
  }, 60000);

  it(`READ ${N_QUERIES} by id (point lookup)`, async () => {
    console.log(`\n[READ ${N_QUERIES} by id]`);

    const sqliteAll = await sqliteDb.getProviderConnections();
    const ids = sqliteAll.slice(0, N_QUERIES).map((c) => c.id);

    const sqliteTime = await bench("SQLite getProviderConnectionById", async () => {
      for (const id of ids) await sqliteDb.getProviderConnectionById(id);
    });

    const legacyIds = legacyData.providerConnections.slice(0, N_QUERIES).map((c) => c.id);
    const legacyTime = await bench("Legacy JSON find by id", async () => {
      for (const id of legacyIds) {
        readLegacy();
        legacyData.providerConnections.find((c) => c.id === id);
      }
    });

    const speedup = (legacyTime / sqliteTime).toFixed(2);
    console.log(`  → SQLite is ${speedup}x faster`);
  }, 60000);

  it(`saveRequestUsage ${N_ITEMS} entries`, async () => {
    console.log(`\n[saveRequestUsage ${N_ITEMS}]`);

    const sqliteTime = await bench("SQLite saveRequestUsage", async () => {
      for (let i = 0; i < N_ITEMS; i++) {
        await sqliteDb.saveRequestUsage({
          provider: "openai", model: `m-${i % 10}`, connectionId: `c-${i % 5}`,
          tokens: { prompt_tokens: 100 + i, completion_tokens: 50 + i },
          endpoint: "/v1/chat/completions", status: "ok",
        });
      }
    });

    const legacyTime = await bench("Legacy JSON push history + write", async () => {
      legacyData.usageHistory = [];
      for (let i = 0; i < N_ITEMS; i++) {
        legacyData.usageHistory.push({
          timestamp: new Date().toISOString(), provider: "openai", model: `m-${i % 10}`,
          connectionId: `c-${i % 5}`, tokens: { prompt_tokens: 100 + i, completion_tokens: 50 + i },
          endpoint: "/v1/chat/completions", status: "ok", cost: 0,
        });
        writeLegacy();
      }
    });

    const speedup = (legacyTime / sqliteTime).toFixed(2);
    console.log(`  → SQLite is ${speedup}x faster`);
  }, 120000);

  it(`getUsageStats(24h) repeat 50x`, async () => {
    console.log(`\n[getUsageStats(24h) x 50]`);

    const sqliteTime = await bench("SQLite getUsageStats(24h)", async () => {
      for (let i = 0; i < 50; i++) await sqliteDb.getUsageStats("24h");
    });

    const legacyTime = await bench("Legacy JSON read + aggregate", async () => {
      for (let i = 0; i < 50; i++) {
        readLegacy();
        const cutoff = Date.now() - 86400000;
        const hist = legacyData.usageHistory.filter((h) => new Date(h.timestamp).getTime() >= cutoff);
        const stats = { byProvider: {}, byModel: {} };
        for (const e of hist) {
          if (!stats.byProvider[e.provider]) stats.byProvider[e.provider] = { requests: 0 };
          stats.byProvider[e.provider].requests++;
        }
      }
    });

    const speedup = (legacyTime / sqliteTime).toFixed(2);
    console.log(`  → SQLite is ${speedup}x faster`);
  }, 60000);
});
