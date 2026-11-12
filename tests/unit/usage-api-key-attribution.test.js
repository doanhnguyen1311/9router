import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
let db;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-api-key-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterEach(() => {
  delete process.env.DATA_DIR;
});

describe("Usage stats API key attribution", () => {
  it("keeps API keys with the same masked prefix in separate buckets", async () => {
    const apiKeyA = "sk-machine-aaaaaa-11111111";
    const apiKeyB = "sk-machine-bbbbbb-22222222";

    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      connectionId: "c1",
      apiKey: apiKeyA,
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat",
      status: "ok",
    });

    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      connectionId: "c1",
      apiKey: apiKeyB,
      tokens: { prompt_tokens: 20, completion_tokens: 10 },
      endpoint: "/v1/chat",
      status: "ok",
    });

    const stats = await db.getUsageStats("24h");
    const apiKeyEntries = Object.values(stats.byApiKey);
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const storedKeys = adapter.all("SELECT apiKey FROM usageHistory ORDER BY id").map((row) => row.apiKey);
    const daily = adapter.get("SELECT data FROM usageDaily LIMIT 1")?.data || "";

    expect(apiKeyEntries).toHaveLength(2);
    expect(storedKeys).toHaveLength(2);
    expect(storedKeys.every((key) => /^h1:[a-f0-9]{64}$/.test(key))).toBe(true);
    expect(storedKeys).not.toContain(apiKeyA);
    expect(storedKeys).not.toContain(apiKeyB);
    expect(daily).not.toContain(apiKeyA);
    expect(daily).not.toContain(apiKeyB);
    expect(Object.keys(stats.byApiKey).join("\n")).not.toContain(apiKeyA);
    expect(Object.keys(stats.byApiKey).join("\n")).not.toContain(apiKeyB);

    expect(
      apiKeyEntries
        .map((entry) => entry.promptTokens)
        .sort((a, b) => a - b)
    ).toEqual([10, 20]);
  });
});
