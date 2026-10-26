import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  get: vi.fn(),
  run: vi.fn(),
  all: vi.fn(),
}));

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: async () => ({
    get: db.get,
    run: db.run,
    all: db.all,
    transaction: (callback) => callback(),
  }),
}));

import { apiKeyEvents } from "@/lib/apiKeyEvents.js";
import { admitApiKeyRequest } from "@/lib/db/repos/apiKeysRepo.js";
import { saveRequestUsage } from "@/lib/db/repos/usageRepo.js";

const keyRow = {
  id: "key-1",
  key: "sk-live-test",
  name: "Live test",
  machineId: "machine-1",
  isActive: 1,
  createdAt: "2026-10-26T00:00:00.000Z",
  accessRestricted: 0,
  accessAllow: null,
  accessAccountRestricted: 0,
  accessAccountIds: null,
  quotaMaxCost: null,
  quotaMaxInputTokens: null,
  quotaMaxRequests: 10,
  quotaUsedCost: 0,
  quotaUsedInputTokens: 0,
  quotaUsedRequests: 0,
  quotaUsageResetAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.run.mockReturnValue({ changes: 1 });
  db.get.mockImplementation((sql) => {
    if (sql.includes("FROM apiKeys WHERE key")) return keyRow;
    return null;
  });
});

describe("API key live usage invalidations", () => {
  it("notifies once when admission consumes a request and once when usage is recorded", async () => {
    let changes = 0;
    const onChange = () => { changes += 1; };
    apiKeyEvents.on("change", onChange);

    try {
      const admission = await admitApiKeyRequest("sk-live-test");
      expect(admission).toMatchObject({ tracked: true, allowed: true, usage: { requests: 1 } });
      expect(changes).toBe(1);

      await saveRequestUsage({
        timestamp: "2026-10-26T12:00:00.000Z",
        provider: null,
        model: "test-model",
        apiKey: "sk-live-test",
        tokens: { input_tokens: 12, output_tokens: 3 },
      });
      expect(changes).toBe(2);
    } finally {
      apiKeyEvents.off("change", onChange);
    }
  });
});
