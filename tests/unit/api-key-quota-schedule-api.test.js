import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  getApiKeyById: vi.fn(),
  updateApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => database);

import { PUT } from "@/app/api/keys/[id]/route.js";

const existing = {
  id: "key-1",
  quota: {
    maxCost: 4,
    maxInputTokens: 400,
    maxRequests: 40,
    resetMode: "scheduled",
    resetInterval: "weekly",
    resetIntervalValue: null,
    resetIntervalUnit: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  database.getApiKeyById.mockResolvedValue(existing);
  database.updateApiKey.mockImplementation(async (id, update) => ({ ...existing, id, ...update }));
});

describe("PUT /api/keys/{id} quota schedule", () => {
  it("preserves a scheduled policy for legacy numeric-only payloads", async () => {
    const response = await PUT(new Request("http://localhost/api/keys/key-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quota: { maxCost: 5, maxInputTokens: 500, maxRequests: 50 } }),
    }), { params: Promise.resolve({ id: "key-1" }) });

    expect(response.status).toBe(200);
    expect(database.updateApiKey).toHaveBeenCalledWith("key-1", {
      quota: {
        maxCost: 5,
        maxInputTokens: 500,
        maxRequests: 50,
        resetMode: "scheduled",
        resetInterval: "weekly",
        resetIntervalValue: null,
        resetIntervalUnit: null,
      },
    });
  });

  it("accepts an explicit switch to admin reset", async () => {
    const response = await PUT(new Request("http://localhost/api/keys/key-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quota: {
        maxCost: null,
        maxInputTokens: null,
        maxRequests: 10,
        resetMode: "manual",
      } }),
    }), { params: Promise.resolve({ id: "key-1" }) });

    expect(response.status).toBe(200);
    expect(database.updateApiKey).toHaveBeenCalledWith("key-1", {
      quota: expect.objectContaining({ resetMode: "manual", resetInterval: null }),
    });
  });

  it("rejects scheduled mode without a valid interval", async () => {
    const response = await PUT(new Request("http://localhost/api/keys/key-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quota: {
        maxCost: null,
        maxInputTokens: null,
        maxRequests: 10,
        resetMode: "scheduled",
        resetInterval: "hourly",
      } }),
    }), { params: Promise.resolve({ id: "key-1" }) });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/daily, weekly, monthly, or custom/);
    expect(database.updateApiKey).not.toHaveBeenCalled();
  });

  it("accepts a custom interval in minutes", async () => {
    const response = await PUT(new Request("http://localhost/api/keys/key-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quota: {
        maxCost: null,
        maxInputTokens: 5000,
        maxRequests: 20,
        resetMode: "scheduled",
        resetInterval: "custom",
        resetIntervalValue: 45,
        resetIntervalUnit: "minutes",
      } }),
    }), { params: Promise.resolve({ id: "key-1" }) });

    expect(response.status).toBe(200);
    expect(database.updateApiKey).toHaveBeenCalledWith("key-1", {
      quota: expect.objectContaining({
        resetInterval: "custom",
        resetIntervalValue: 45,
        resetIntervalUnit: "minutes",
      }),
    });
  });
});
