import { describe, expect, it, vi } from "vitest";

describe("Planning approval API security", () => {
  it("rejects cross-origin approval before identity or state mutation", async () => {
    const route = await import("@/app/api/v1/projects/[id]/plans/[planId]/approve/route.js");
    const response = await route.POST(new Request("https://router.example/api/v1/projects/project-a/plans/plan-a/approve", {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 3,
        optionId: "option-a",
        scope: "EXECUTE_APPROVED_PLAN",
        idempotencyKey: "cross-origin-approval-0001",
      }),
    }), { params: Promise.resolve({ id: "project-a", planId: "plan-a" }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CROSS_ORIGIN_MUTATION" });
  });

  it("requires an authenticated admin session for API-key Planning changes", async () => {
    vi.resetModules();
    const route = await import("@/app/api/keys/[id]/route.js");
    const response = await route.PUT(new Request("https://router.example/api/keys/key-a", {
      method: "PUT",
      headers: { origin: "https://router.example", "content-type": "application/json" },
      body: JSON.stringify({ planning: { planningEnabled: false, planningMode: "OFF" } }),
    }), { params: Promise.resolve({ id: "key-a" }) });
    expect(response.status).toBe(401);
  });
});
