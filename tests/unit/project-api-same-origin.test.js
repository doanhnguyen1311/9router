import { beforeEach, describe, expect, it, vi } from "vitest";

const { getProjectIdentity, consumeProjectApiBudget } = vi.hoisted(() => ({
  getProjectIdentity: vi.fn(),
  consumeProjectApiBudget: vi.fn(),
}));

vi.mock("@/lib/projectMemory/identity.js", () => ({ getProjectIdentity }));
vi.mock("@/lib/projectMemory/rateLimit.js", () => ({ consumeProjectApiBudget }));

describe("Project API same-origin enforcement", () => {
  beforeEach(() => {
    vi.resetModules();
    getProjectIdentity.mockReset().mockResolvedValue({ principalId: "local-admin" });
    consumeProjectApiBudget.mockReset().mockReturnValue({ allowed: true });
  });

  it("rejects a browser mutation from a different origin before identity lookup", async () => {
    const { requireIdentity } = await import("../../src/app/api/projects/_response.js");
    const request = new Request("https://router.example/api/projects", {
      method: "POST",
      headers: { host: "router.example", origin: "https://attacker.example", "content-type": "application/json" },
      body: "{}",
    });

    await expect(requireIdentity(request)).rejects.toMatchObject({ status: 403, code: "CROSS_ORIGIN_MUTATION" });
    expect(getProjectIdentity).not.toHaveBeenCalled();
  });

  it("accepts same-origin browser writes and origin-less authenticated API clients", async () => {
    const { requireIdentity } = await import("../../src/app/api/projects/_response.js");
    const sameOrigin = new Request("https://router.example/api/projects", {
      method: "POST",
      headers: { host: "router.example", origin: "https://router.example", "content-type": "application/json" },
      body: "{}",
    });
    const apiClient = new Request("https://router.example/api/projects", {
      method: "POST",
      headers: { host: "router.example", authorization: "Bearer test" },
      body: "{}",
    });

    await expect(requireIdentity(sameOrigin)).resolves.toMatchObject({ principalId: "local-admin" });
    await expect(requireIdentity(apiClient)).resolves.toMatchObject({ principalId: "local-admin" });
    expect(getProjectIdentity).toHaveBeenCalledTimes(2);
  });
});
