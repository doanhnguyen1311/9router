import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-usage-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("API key self-service usage summary", () => {
  it("returns only the active key's current-window totals and model breakdown", async () => {
    const { database, adapter } = await boot();
    const key = await database.createApiKey("Customer A", "machine", {
      maxCost: 10,
      maxInputTokens: 1000,
      maxRequests: 50,
      resetMode: "manual",
      resetInterval: null,
    });

    adapter.run(
      `UPDATE apiKeys SET
        createdAt = ?, quotaUsedCost = ?, quotaUsedInputTokens = ?,
        quotaUsedRequests = ?, quotaUsageResetAt = ?
       WHERE id = ?`,
      ["2025-01-01T00:00:00.000Z", 0.125, 140, 3, "2026-01-01T00:00:00.000Z", key.id],
    );

    const insert = (timestamp, provider, model, input, output, cost) => adapter.run(
      `INSERT INTO usageHistory(
        timestamp, provider, model, apiKey, promptTokens,
        completionTokens, cost, status, tokens, meta
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'ok', '{}', '{}')`,
      [timestamp, provider, model, key.key, input, output, cost],
    );

    insert("2025-12-31T23:59:59.000Z", "old-provider", "old-model", 999, 999, 99);
    insert("2026-01-02T12:00:00.000Z", "openai", "gpt-5", 100, 25, 0.1);
    insert("2026-01-03T12:00:00.000Z", "anthropic", "claude-sonnet", 40, 10, 0.025);

    const summary = await database.getApiKeyUsageSummary(key.key);

    expect(summary).toMatchObject({
      key: { name: "Customer A", isActive: true },
      window: { startedAt: "2026-01-01T00:00:00.000Z", resetMode: "manual" },
      quota: { maxCost: 10, maxInputTokens: 1000, maxRequests: 50 },
      usage: {
        requests: 3,
        recordedRequests: 2,
        inputTokens: 140,
        outputTokens: 35,
        totalTokens: 175,
        cost: 0.125,
        modelCount: 2,
      },
    });
    expect(summary.models.map((model) => `${model.provider}/${model.model}`)).toEqual([
      "openai/gpt-5",
      "anthropic/claude-sonnet",
    ]);
    expect(JSON.stringify(summary)).not.toContain(key.key);
    expect(summary.key.masked).toMatch(/^sk-.+\*\*\*.+$/);
  });

  it("rejects disabled and unknown keys without returning usage", async () => {
    const { database } = await boot();
    const key = await database.createApiKey("Disabled", "machine");
    await database.updateApiKey(key.id, { isActive: false });
    const expired = await database.createApiKey("Expired", "machine", {
      maxCost: null,
      maxInputTokens: null,
      maxRequests: null,
      resetMode: "manual",
      resetInterval: null,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    expect(await database.getApiKeyUsageSummary(key.key)).toBeNull();
    expect(await database.getApiKeyUsageSummary(expired.key)).toBeNull();
    expect(await database.getApiKeyUsageSummary("sk-does-not-exist")).toBeNull();
  });

  it("prices legacy zero-cost rows that stored a virtual thinking suffix", async () => {
    const { database, adapter } = await boot();
    const key = await database.createApiKey("Legacy suffix", "machine");
    adapter.run(
      `UPDATE apiKeys SET createdAt = ?, quotaUsedInputTokens = ?, quotaUsedRequests = ? WHERE id = ?`,
      ["2025-01-01T00:00:00.000Z", 1000, 1, key.id],
    );
    adapter.run(
      `INSERT INTO usageHistory(
        timestamp, provider, model, apiKey, promptTokens,
        completionTokens, cost, status, tokens, meta
      ) VALUES(?, ?, ?, ?, ?, ?, 0, 'ok', ?, '{}')`,
      [
        "2026-01-02T12:00:00.000Z",
        "codex",
        "gpt-6.1-sol(xhigh)",
        key.key,
        1000,
        100,
        JSON.stringify({ prompt_tokens: 1000, completion_tokens: 100, cached_tokens: 500 }),
      ],
    );

    const summary = await database.getApiKeyUsageSummary(key.key);

    // 500 regular input × $2 + 500 cached × $0.10 + 100 output × $10, per 1M.
    expect(summary.usage.cost).toBeCloseTo(0.00205, 12);
    expect(summary.models[0]).toMatchObject({
      provider: "codex",
      model: "gpt-6.1-sol(xhigh)",
    });
    expect(summary.models[0].cost).toBeCloseTo(0.00205, 12);
  });
});
