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
  return database;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-model-routing-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("API key public model routing", () => {
  it("persists one fixed name and defaults it to the first allowed model", async () => {
    const db = await boot();
    const key = await db.createApiKey("Customer", "machine");
    await db.updateApiKey(key.id, {
      access: {
        restricted: true,
        allow: ["cx/gpt-6.1-sol", "anthropic/claude-sonnet"],
        accountRestricted: false,
        accountIds: [],
      },
    });

    const updated = await db.updateApiKey(key.id, {
      modelRouting: { alias: "coding-model", selectedModel: null },
    });
    expect(updated.modelRouting).toEqual({
      alias: "coding-model",
      selectedModel: "cx/gpt-6.1-sol",
    });

    const selected = await db.updateApiKey(key.id, {
      modelRouting: { alias: "coding-model", selectedModel: "ANTHROPIC/CLAUDE-SONNET" },
    });
    expect(selected.modelRouting.selectedModel).toBe("anthropic/claude-sonnet");

    const summary = await db.getApiKeyUsageSummary(key.key);
    expect(summary.modelAccess).toEqual({
      restricted: true,
      allowedModels: ["cx/gpt-6.1-sol", "anthropic/claude-sonnet"],
      publicModel: "coding-model",
      selectedModel: "anthropic/claude-sonnet",
    });

    const backup = await db.exportDb();
    await db.importDb(backup);
    expect((await db.getApiKeyById(key.id)).modelRouting).toEqual({
      alias: "coding-model",
      selectedModel: "anthropic/claude-sonnet",
    });
  });

  it("keeps the selection valid when the admin changes the allowlist", async () => {
    const db = await boot();
    const key = await db.createApiKey("Customer", "machine");
    await db.updateApiKey(key.id, {
      access: { restricted: true, allow: ["a/model", "b/model"], accountRestricted: false, accountIds: [] },
      modelRouting: { alias: "public-model", selectedModel: "b/model" },
    });
    const updated = await db.updateApiKey(key.id, {
      access: { restricted: true, allow: ["c/model", "a/model"], accountRestricted: false, accountIds: [] },
    });
    expect(updated.modelRouting).toEqual({ alias: "public-model", selectedModel: "c/model" });
  });

  it("rejects duplicate public names and targets outside the allowlist", async () => {
    const db = await boot();
    const first = await db.createApiKey("First", "machine");
    const second = await db.createApiKey("Second", "machine");
    for (const key of [first, second]) {
      await db.updateApiKey(key.id, {
        access: { restricted: true, allow: ["cx/gpt-6.1-sol"], accountRestricted: false, accountIds: [] },
      });
    }
    await db.updateApiKey(first.id, {
      modelRouting: { alias: "coding-model", selectedModel: "cx/gpt-6.1-sol" },
    });

    await expect(db.updateApiKey(second.id, {
      modelRouting: { alias: "CODING-MODEL", selectedModel: "cx/gpt-6.1-sol" },
    })).rejects.toMatchObject({ code: "KEY_MODEL_ALIAS_CONFLICT" });
    await expect(db.updateApiKey(second.id, {
      modelRouting: { alias: "other-model", selectedModel: "cx/not-allowed" },
    })).rejects.toMatchObject({ code: "INVALID_KEY_MODEL_ROUTING" });
    await expect(db.updateApiKey(second.id, {
      modelRouting: { alias: "cx/gpt-6.1-sol", selectedModel: "cx/gpt-6.1-sol" },
    })).rejects.toMatchObject({ code: "INVALID_KEY_MODEL_ROUTING" });
  });

  it("lets the key owner switch only among admin-allowed models", async () => {
    const db = await boot();
    const key = await db.createApiKey("Customer", "machine");
    await db.updateApiKey(key.id, {
      access: {
        restricted: true,
        allow: ["cx/gpt-6.1-sol", "anthropic/claude-sonnet"],
        accountRestricted: false,
        accountIds: [],
      },
      modelRouting: { alias: "coding-model", selectedModel: "cx/gpt-6.1-sol" },
    });

    const { PATCH } = await import("@/app/api/key-usage/route.js");
    const select = (selectedModel) => PATCH(new Request("http://localhost/api/key-usage", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${key.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ selectedModel }),
    }));

    const allowed = await select("anthropic/claude-sonnet");
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).modelAccess.selectedModel).toBe("anthropic/claude-sonnet");
    expect((await db.getApiKeyById(key.id)).modelRouting.selectedModel).toBe("anthropic/claude-sonnet");

    const denied = await select("openai/not-allowed");
    expect(denied.status).toBe(403);
    expect((await db.getApiKeyById(key.id)).modelRouting.selectedModel).toBe("anthropic/claude-sonnet");
  });
});
