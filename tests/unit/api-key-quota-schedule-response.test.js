import { afterEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({ admitApiKeyRequest: vi.fn() }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => repository);

import { enforceApiKeyQuota, quotaExceededMessage } from "@/sse/services/apiKeyQuota.js";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("scheduled API key quota response", () => {
  it("returns reset metadata and Retry-After for a scheduled window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T00:00:00.000Z"));
    repository.admitApiKeyRequest.mockResolvedValue({
      tracked: true,
      allowed: false,
      exceeded: { kind: "requests", used: 10, limit: 10 },
      quota: { resetMode: "scheduled", resetInterval: "daily" },
      usage: { nextResetAt: "2026-10-26T01:00:00.000Z" },
    });

    const response = await enforceApiKeyQuota(new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: "Bearer sk-scheduled" },
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(response.headers.get("x-9router-quota-reset-at")).toBe("2026-10-26T01:00:00.000Z");
    expect((await response.json()).error.message).toContain("resets automatically");
  });

  it("keeps manual windows admin-controlled without retry metadata", async () => {
    repository.admitApiKeyRequest.mockResolvedValue({
      tracked: true,
      allowed: false,
      exceeded: { kind: "input_tokens", used: 1000, limit: 1000 },
      quota: { resetMode: "manual", resetInterval: null },
      usage: { nextResetAt: null },
    });

    const response = await enforceApiKeyQuota(new Request("http://localhost/v1/responses", {
      headers: { "x-api-key": "sk-manual" },
    }));

    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.headers.get("x-9router-quota-reset-at")).toBeNull();
    expect((await response.json()).error.message).toContain("admin must reset usage");
  });

  it("formats legacy direct calls with manual reset guidance", () => {
    expect(quotaExceededMessage({ kind: "cost", used: 2, limit: 2 })).toContain("admin must reset usage");
  });
});
