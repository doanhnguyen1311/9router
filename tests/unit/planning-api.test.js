import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const identity = { principalId: "local-admin", displayName: "Local Admin", admin: true };

const output = {
  interpretedObjective: "Create an API-backed plan",
  assumptions: [],
  missingInformation: [],
  constraints: ["Do not execute"],
  affectedModules: ["src/app/api/v1"],
  risks: [],
  options: [{
    name: "API option",
    summary: "Persist through the API",
    architecture: "Route to service to repository.",
    implementationSteps: ["Call the route"],
    filesAffected: ["route.js"],
    pros: ["Versioned"],
    cons: [],
    risks: [],
    complexity: "low",
    compatibility: "Existing routes stay unchanged.",
    acceptanceCriteria: ["201 response"],
    testStrategy: ["Route integration test"],
  }],
  recommendedOptionIndex: 0,
};

function provider() {
  return {
    validateCapabilities: vi.fn(async () => ({ structuredOutput: true })),
    generatePlan: vi.fn(async () => ({ plan: output, usage: {}, attempts: 1 })),
    revisePlan: vi.fn(async () => ({ plan: output, usage: {}, attempts: 1 })),
    healthCheck: vi.fn(async () => ({ ok: true })),
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-planning-api-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  vi.clearAllMocks();
  vi.resetModules();
  vi.doUnmock("@/lib/projectMemory/identity.js");
  vi.doUnmock("@/lib/planning/routerProvider.js");
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Versioned planning API", () => {
  it("connects create/list/select routes to the real persistence layer", async () => {
    const selectedProvider = provider();
    vi.doMock("@/lib/projectMemory/identity.js", () => ({ getProjectIdentity: vi.fn(async () => identity) }));
    vi.doMock("@/lib/planning/routerProvider.js", () => ({ getPlanningProvider: () => selectedProvider }));

    const projects = await import("@/lib/projectMemory/repository.js");
    const project = await projects.createProject({ name: "Planning API" }, identity);
    const collection = await import("@/app/api/v1/projects/[id]/plans/route.js");
    const createRequest = new Request(`https://router.example/api/v1/projects/${project.id}/plans`, {
      method: "POST",
      headers: { origin: "https://router.example", "content-type": "application/json" },
      body: JSON.stringify({ originalRequest: "Plan the API", providerId: "openai", modelId: "gpt-5" }),
    });
    const createResponse = await collection.POST(createRequest, { params: Promise.resolve({ id: project.id }) });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()).plan;
    expect(created).toMatchObject({ projectId: project.id, status: "OPTIONS_READY" });

    const listResponse = await collection.GET(
      new Request(`https://router.example/api/v1/projects/${project.id}/plans`),
      { params: Promise.resolve({ id: project.id }) },
    );
    expect(listResponse.status).toBe(200);
    expect((await listResponse.json()).plans).toHaveLength(1);

    const selectRoute = await import("@/app/api/v1/projects/[id]/plans/[planId]/select-option/route.js");
    const selectResponse = await selectRoute.POST(new Request(
      `https://router.example/api/v1/projects/${project.id}/plans/${created.id}/select-option`,
      {
        method: "POST",
        headers: { origin: "https://router.example", "content-type": "application/json" },
        body: JSON.stringify({ optionId: created.options[0].id, expectedVersion: created.version }),
      },
    ), { params: Promise.resolve({ id: project.id, planId: created.id }) });
    expect(selectResponse.status).toBe(200);
    const selected = (await selectResponse.json()).plan;
    expect(selected.selectedOptionId).toBe(created.options[0].id);

    const requestApprovalRoute = await import("@/app/api/v1/projects/[id]/plans/[planId]/request-approval/route.js");
    const requestedResponse = await requestApprovalRoute.POST(new Request(
      `https://router.example/api/v1/projects/${project.id}/plans/${created.id}/request-approval`,
      {
        method: "POST",
        headers: { origin: "https://router.example", "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: selected.version }),
      },
    ), { params: Promise.resolve({ id: project.id, planId: created.id }) });
    expect(requestedResponse.status).toBe(200);
    const requested = (await requestedResponse.json()).plan;

    const approveRoute = await import("@/app/api/v1/projects/[id]/plans/[planId]/approve/route.js");
    const approveResponse = await approveRoute.POST(new Request(
      `https://router.example/api/v1/projects/${project.id}/plans/${created.id}/approve`,
      {
        method: "POST",
        headers: { origin: "https://router.example", "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: requested.version,
          optionId: created.options[0].id,
          scope: "EXECUTE_APPROVED_PLAN",
          idempotencyKey: "planning-api-approval-000001",
        }),
      },
    ), { params: Promise.resolve({ id: project.id, planId: created.id }) });
    expect(approveResponse.status).toBe(200);
    expect((await approveResponse.json()).plan.status).toBe("APPROVED");
  });

  it("rejects cross-origin mutations before invoking the planning provider", async () => {
    const selectedProvider = provider();
    vi.doMock("@/lib/projectMemory/identity.js", () => ({ getProjectIdentity: vi.fn(async () => identity) }));
    vi.doMock("@/lib/planning/routerProvider.js", () => ({ getPlanningProvider: () => selectedProvider }));
    const projects = await import("@/lib/projectMemory/repository.js");
    const project = await projects.createProject({ name: "Planning CSRF" }, identity);
    const route = await import("@/app/api/v1/projects/[id]/plans/route.js");
    const response = await route.POST(new Request(`https://router.example/api/v1/projects/${project.id}/plans`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ originalRequest: "Steal context", providerId: "openai", modelId: "gpt-5" }),
    }), { params: Promise.resolve({ id: project.id }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CROSS_ORIGIN_MUTATION" });
    expect(selectedProvider.generatePlan).not.toHaveBeenCalled();
  });
});
