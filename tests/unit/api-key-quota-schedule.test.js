import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNextQuotaResetAt,
  resolveQuotaResetSchedule,
  validateKeyQuotaInput,
} from "@/shared/utils/keyQuota.js";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

async function boot() {
  delete global._dbAdapter;
  vi.resetModules();
  const database = await import("@/lib/db/index.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  return { database, adapter: await getAdapter() };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-schedule-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("API key quota reset contract", () => {
  it("keeps legacy quota payloads manual and validates scheduled intervals", () => {
    expect(validateKeyQuotaInput({ maxCost: 1, maxInputTokens: 2, maxRequests: 3 })).toEqual({
      ok: true,
      value: {
        maxCost: 1,
        maxInputTokens: 2,
        maxRequests: 3,
        resetMode: "manual",
        resetInterval: null,
        resetIntervalValue: null,
        resetIntervalUnit: null,
        expiresAt: null,
      },
    });
    expect(validateKeyQuotaInput({
      maxCost: null,
      maxInputTokens: null,
      maxRequests: 3,
      resetMode: "scheduled",
      resetInterval: "hourly",
    })).toMatchObject({ ok: false });
  });

  it("normalizes an optional key expiration and rejects invalid values", () => {
    expect(validateKeyQuotaInput({
      maxCost: null,
      maxInputTokens: null,
      maxRequests: 3,
      expiresAt: "2099-01-01T12:00:00+07:00",
    })).toMatchObject({
      ok: true,
      value: { expiresAt: "2099-01-01T05:00:00.000Z" },
    });
    expect(validateKeyQuotaInput({
      maxCost: null,
      maxInputTokens: null,
      maxRequests: 3,
      expiresAt: "not-a-date",
    })).toMatchObject({ ok: false });
  });

  it("computes daily, weekly, and clamped calendar-month boundaries", () => {
    const start = "2026-01-31T12:30:00.000Z";
    expect(getNextQuotaResetAt("daily", start)).toBe("2026-02-01T12:30:00.000Z");
    expect(getNextQuotaResetAt("weekly", start)).toBe("2026-02-07T12:30:00.000Z");
    expect(getNextQuotaResetAt("monthly", start)).toBe("2026-02-28T12:30:00.000Z");
  });

  it("validates and computes custom minute, hour, and day intervals", () => {
    expect(validateKeyQuotaInput({
      maxCost: null,
      maxInputTokens: 100,
      maxRequests: null,
      resetMode: "scheduled",
      resetInterval: "custom",
      resetIntervalValue: 90,
      resetIntervalUnit: "minutes",
    })).toMatchObject({
      ok: true,
      value: {
        resetInterval: "custom",
        resetIntervalValue: 90,
        resetIntervalUnit: "minutes",
      },
    });
    expect(getNextQuotaResetAt("custom", "2026-10-26T12:00:00.000Z", 15, "minutes"))
      .toBe("2026-10-26T12:15:00.000Z");
    expect(getNextQuotaResetAt("custom", "2026-10-26T12:00:00.000Z", 6, "hours"))
      .toBe("2026-10-26T18:00:00.000Z");
    expect(getNextQuotaResetAt("custom", "2026-10-26T12:00:00.000Z", 3, "days"))
      .toBe("2026-10-29T12:00:00.000Z");
  });

  it("rejects incomplete or invalid custom intervals", () => {
    const base = {
      maxCost: null,
      maxInputTokens: null,
      maxRequests: 5,
      resetMode: "scheduled",
      resetInterval: "custom",
    };
    expect(validateKeyQuotaInput(base)).toMatchObject({ ok: false });
    expect(validateKeyQuotaInput({ ...base, resetIntervalValue: 0, resetIntervalUnit: "minutes" }))
      .toMatchObject({ ok: false });
    expect(validateKeyQuotaInput({ ...base, resetIntervalValue: 1.5, resetIntervalUnit: "hours" }))
      .toMatchObject({ ok: false });
    expect(validateKeyQuotaInput({ ...base, resetIntervalValue: 2, resetIntervalUnit: "weeks" }))
      .toMatchObject({ ok: false });
  });

  it("advances missed windows to the first future boundary", () => {
    expect(resolveQuotaResetSchedule(
      { resetMode: "scheduled", resetInterval: "daily" },
      "2026-10-20T12:00:00.000Z",
      "2026-10-22T12:30:00.000Z",
    )).toEqual({
      due: true,
      resetAt: "2026-10-22T12:00:00.000Z",
      nextResetAt: "2026-10-23T12:00:00.000Z",
    });
  });

  it("initializes a missing schedule without treating it as an expired 1970 window", () => {
    const resolved = resolveQuotaResetSchedule(
      { resetMode: "scheduled", resetInterval: "weekly" },
      null,
      "2026-10-26T12:00:00.000Z",
    );
    expect(resolved).toEqual({
      due: false,
      resetAt: null,
      nextResetAt: "2026-11-02T12:00:00.000Z",
    });
  });

  it("advances a missed custom interval without replaying each window", () => {
    expect(resolveQuotaResetSchedule(
      {
        resetMode: "scheduled",
        resetInterval: "custom",
        resetIntervalValue: 30,
        resetIntervalUnit: "minutes",
      },
      "2026-10-26T10:00:00.000Z",
      "2026-10-26T12:05:00.000Z",
    )).toEqual({
      due: true,
      resetAt: "2026-10-26T12:00:00.000Z",
      nextResetAt: "2026-10-26T12:30:00.000Z",
    });
  });
});

describe("API key quota reset persistence", () => {
  it("rejects an expired key without consuming another request", async () => {
    const { database } = await boot();
    const key = await database.createApiKey("expired", "machine", {
      maxCost: null,
      maxInputTokens: null,
      maxRequests: 10,
      resetMode: "manual",
      resetInterval: null,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    expect(key.isExpired).toBe(true);
    expect(await database.validateApiKey(key.key)).toBe(false);
    expect(await database.admitApiKeyRequest(key.key)).toMatchObject({
      tracked: true,
      allowed: false,
      reason: "expired",
      expiresAt: "2000-01-01T00:00:00.000Z",
      usage: { requests: 0 },
    });
    expect((await database.getApiKeyById(key.id)).usage.requests).toBe(0);
  });

  it("blocks a manual quota until admin reset", async () => {
    const { database } = await boot();
    const key = await database.createApiKey("manual", "machine", {
      maxCost: null,
      maxInputTokens: null,
      maxRequests: 1,
      resetMode: "manual",
      resetInterval: null,
    });

    expect((await database.admitApiKeyRequest(key.key)).allowed).toBe(true);
    expect((await database.admitApiKeyRequest(key.key)).allowed).toBe(false);
    await database.resetApiKeyUsage(key.id);
    expect((await database.admitApiKeyRequest(key.key)).allowed).toBe(true);
  });

  it("atomically clears an expired scheduled window before admission", async () => {
    const { database, adapter } = await boot();
    const key = await database.createApiKey("daily", "machine", {
      maxCost: null,
      maxInputTokens: null,
      maxRequests: 1,
      resetMode: "scheduled",
      resetInterval: "daily",
    });
    adapter.run(
      `UPDATE apiKeys SET quotaUsedRequests = 1, quotaUsedInputTokens = 55, quotaUsedCost = 0.25, quotaNextResetAt = ? WHERE id = ?`,
      ["2026-10-20T12:00:00.000Z", key.id],
    );

    const admission = await database.admitApiKeyRequest(key.key);
    expect(admission).toMatchObject({ tracked: true, allowed: true, usage: { requests: 1, inputTokens: 0, cost: 0 } });
    expect(new Date(admission.usage.nextResetAt).getTime()).toBeGreaterThan(Date.now());

    const stored = await database.getApiKeyById(key.id);
    expect(stored.usage).toMatchObject({ requests: 1, inputTokens: 0, cost: 0 });
    expect(stored.usage.resetAt).toBeTruthy();
  });

  it("records a response that crosses the boundary in the new usage window", async () => {
    const { database, adapter } = await boot();
    const key = await database.createApiKey("cross-boundary", "machine", {
      maxCost: null,
      maxInputTokens: 100,
      maxRequests: 10,
      resetMode: "scheduled",
      resetInterval: "daily",
    });
    adapter.run(
      `UPDATE apiKeys SET quotaUsedRequests = 1, quotaUsedInputTokens = 90, quotaNextResetAt = ? WHERE id = ?`,
      ["2026-10-20T12:00:00.000Z", key.id],
    );

    await database.saveRequestUsage({
      timestamp: "2026-10-26T12:00:00.000Z",
      provider: null,
      model: "test-model",
      apiKey: key.key,
      tokens: { input_tokens: 25, output_tokens: 1 },
    });

    expect((await database.getApiKeyById(key.id)).usage).toMatchObject({
      requests: 0,
      inputTokens: 25,
    });
  });

  it("round-trips reset policies and next boundaries through backup import", async () => {
    const { database } = await boot();
    const created = await database.createApiKey("backup", "machine", {
      maxCost: 3,
      maxInputTokens: null,
      maxRequests: 30,
      resetMode: "scheduled",
      resetInterval: "custom",
      resetIntervalValue: 45,
      resetIntervalUnit: "minutes",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const before = await database.getApiKeyById(created.id);
    const dump = await database.exportDb();

    await database.importDb(dump);
    const restored = await database.getApiKeyById(created.id);
    expect(restored.quota).toEqual(before.quota);
    expect(restored.usage.nextResetAt).toBe(before.usage.nextResetAt);

    const legacyDump = {
      ...dump,
      apiKeys: dump.apiKeys.map(({ quota, usage, ...key }) => ({
        ...key,
        quota: {
          maxCost: quota.maxCost,
          maxInputTokens: quota.maxInputTokens,
          maxRequests: quota.maxRequests,
        },
        usage: { ...usage, nextResetAt: undefined },
      })),
    };
    await database.importDb(legacyDump);
    expect((await database.getApiKeyById(created.id)).quota).toMatchObject({
      resetMode: "manual",
      resetInterval: null,
    });
  });

  it("upgrades schema v5 rows without losing their reset policy or usage", async () => {
    fs.mkdirSync(path.join(tempDir, "db"), { recursive: true });
    const sqlite = new DatabaseSync(path.join(tempDir, "db", "data.sqlite"));
    sqlite.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta(key, value) VALUES ('schemaVersion', '0'), ('backupSchemaVersion', '5');
      CREATE TABLE apiKeys (
        id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT,
        isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL, modelAlias TEXT,
        quotaMaxRequests INTEGER, quotaUsedRequests INTEGER DEFAULT 0,
        quotaResetMode TEXT DEFAULT 'manual', quotaResetInterval TEXT, quotaNextResetAt TEXT
      );
      INSERT INTO apiKeys(
        id, key, name, machineId, isActive, createdAt, quotaMaxRequests, quotaUsedRequests,
        quotaResetMode, quotaResetInterval, quotaNextResetAt
      ) VALUES (
        'legacy', 'sk-legacy', 'legacy', 'machine', 1, '2026-01-01T00:00:00.000Z', 5, 3,
        'scheduled', 'weekly', '2026-12-01T00:00:00.000Z'
      );
    `);
    sqlite.close();

    const { database, adapter } = await boot();
    const columns = adapter.all(`PRAGMA table_info(apiKeys)`).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      "quotaResetMode",
      "quotaResetInterval",
      "quotaResetIntervalValue",
      "quotaResetIntervalUnit",
      "quotaExpiresAt",
      "quotaNextResetAt",
    ]));
    expect(await database.getApiKeyById("legacy")).toMatchObject({
      quota: { maxRequests: 5, resetMode: "scheduled", resetInterval: "weekly" },
      usage: { requests: 3, nextResetAt: "2026-12-01T00:00:00.000Z" },
    });
    expect(fs.readdirSync(path.join(tempDir, "db", "backups")).some((name) => name.startsWith("schema-5-to-9"))).toBe(true);
  });
});
