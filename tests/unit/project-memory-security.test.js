import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-project-security-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._projectApiRateLimits;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete global._projectApiRateLimits;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Project Memory security controls", () => {
  it("redacts PII, valid payment cards, JWTs, and API tokens", async () => {
    const { redactProjectText } = await import("@/lib/projectMemory/privacy.js");
    const raw = "owner@example.com 4111 1111 1111 1111 eyJabcdefgh.abcdefgh.abcdefgh sk-abcdefghijklmnopqrstuvwxyz";
    const result = redactProjectText(raw);
    expect(result.text).not.toContain("owner@example.com");
    expect(result.text).not.toContain("4111 1111 1111 1111");
    expect(result.text).not.toContain("eyJabcdefgh.abcdefgh.abcdefgh");
    expect(result.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(result.findings).toEqual(expect.arrayContaining(["pii-email", "pii-payment-card", "jwt", "api-token"]));
  });

  it("separates read and write rate budgets and emits a retry window", async () => {
    const { consumeProjectApiBudget, __test__ } = await import("@/lib/projectMemory/rateLimit.js");
    const principal = `test:${Date.now()}`;
    for (let index = 0; index < __test__.WRITE_LIMIT; index += 1) {
      expect(consumeProjectApiBudget(principal, { method: "POST" }).allowed).toBe(true);
    }
    expect(consumeProjectApiBudget(principal, { method: "POST" })).toMatchObject({ allowed: false, retryAfter: expect.any(Number) });
    expect(consumeProjectApiBudget(principal, { method: "GET" }).allowed).toBe(true);
  });

  it("enables SQLite secure deletion and recovers expired durable leases", async () => {
    const repository = await import("@/lib/projectMemory/repository.js");
    const queue = await import("@/lib/projectMemory/queue.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    expect(adapter.get("PRAGMA secure_delete").secure_delete).toBe(1);
    const project = await repository.createProject({ name: "Recovery" }, { principalId: "local-admin" });
    const queued = await queue.enqueueMemoryEvent({
      projectId: project.id, eventType: "request-user", sourceType: "user-confirmed",
      payload: { text: "We must retain durable queue recovery evidence." },
    });
    if (global._projectMemoryWorker?.timer) clearTimeout(global._projectMemoryWorker.timer);
    global._projectMemoryWorker.scheduled = false;
    adapter.run(
      "UPDATE extractionJobs SET state='processing', leaseOwner='dead-worker', leaseUntil=? WHERE id=?",
      ["2000-01-01T00:00:00.000Z", queued.jobId],
    );
    expect(await queue.recoverStaleJobs()).toBe(1);
    expect(adapter.get("SELECT state, leaseOwner FROM extractionJobs WHERE id=?", [queued.jobId]))
      .toMatchObject({ state: "pending", leaseOwner: null });
    expect(adapter.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(adapter.get("PRAGMA integrity_check").integrity_check).toBe("ok");
  });

  it("rewraps stored and v2 credentials when an API key machine binding changes", async () => {
    const database = await import("@/lib/db/index.js");
    const created = await database.createApiKey("rewrap", "machine-a", undefined, {
      enabled: true,
      upstreamBaseUrl: "https://example.test/v1",
      upstreamApiKey: "upstream-secret-value",
    });
    const updated = await database.updateApiKey(created.id, { machineId: "machine-b" });
    expect(updated.key).toBe(created.key);
    expect((await database.getApiKeyByKey(created.key)).machineId).toBe("machine-b");
    const v2 = await database.getV2ProxyConfigByKey(created.key);
    expect(v2).toMatchObject({ invalid: false, config: { upstreamApiKey: "upstream-secret-value" } });
  });
});
