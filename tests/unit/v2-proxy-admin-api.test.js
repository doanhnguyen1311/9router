import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  admin: false,
  config: {
    enabled: true,
    upstreamBaseUrl: "https://hidden.example/v1",
    upstreamApiKey: "hidden-secret",
    configured: true,
    credentialReadable: true,
  },
}));

const database = vi.hoisted(() => ({
  getV2ProxyAdminConfigById: vi.fn(),
  updateV2ProxyAdminConfigById: vi.fn(),
}));

vi.mock("@/lib/auth/adminSession.js", () => ({
  hasAdminSession: async () => state.admin,
}));
vi.mock("@/lib/localDb", () => database);

import { GET, PUT } from "@/app/api/keys/[id]/v2-config/route.js";

const context = { params: Promise.resolve({ id: "key-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  state.admin = false;
  database.getV2ProxyAdminConfigById.mockResolvedValue(state.config);
  database.updateV2ProxyAdminConfigById.mockResolvedValue(state.config);
});

describe("admin V2 configuration API", () => {
  it("does not decrypt or update configuration without an admin session", async () => {
    expect((await GET(new Request("http://localhost/api/keys/key-1/v2-config"), context)).status)
      .toBe(401);
    expect((await PUT(new Request("http://localhost/api/keys/key-1/v2-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v2Proxy: { enabled: false } }),
    }), context)).status).toBe(401);
    expect(database.getV2ProxyAdminConfigById).not.toHaveBeenCalled();
    expect(database.updateV2ProxyAdminConfigById).not.toHaveBeenCalled();
  });

  it("returns plaintext only to an admin and prevents response caching", async () => {
    state.admin = true;
    const response = await GET(new Request("http://localhost/api/keys/key-1/v2-config"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toEqual({ v2Proxy: state.config });
    expect(database.getV2ProxyAdminConfigById).toHaveBeenCalledWith("key-1");
  });

  it("accepts a full admin replacement with a non-cacheable response", async () => {
    state.admin = true;
    const v2Proxy = {
      enabled: true,
      upstreamBaseUrl: "https://replacement.example/v1",
      upstreamApiKey: "replacement-secret",
    };
    const response = await PUT(new Request("http://localhost/api/keys/key-1/v2-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v2Proxy }),
    }), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(database.updateV2ProxyAdminConfigById).toHaveBeenCalledWith("key-1", v2Proxy);
  });

  it("does not interpret a malformed admin payload as a request to erase V2", async () => {
    state.admin = true;
    for (const body of [{}, { v2Proxy: null }]) {
      const response = await PUT(new Request("http://localhost/api/keys/key-1/v2-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }), context);
      expect(response.status).toBe(400);
    }
    expect(database.updateV2ProxyAdminConfigById).not.toHaveBeenCalled();
  });
});
