import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const owner = { principalId: "local-admin", displayName: "Local Admin", admin: true };

const output = {
  interpretedObjective: "Drive approval through an API-key-owned planning session",
  assumptions: [],
  missingInformation: [],
  constraints: ["Human approval is mandatory"],
  affectedModules: ["src/app/api/v1/planning/sessions"],
  risks: [],
  options: [{
    name: "Versioned actions",
    summary: "Use one exact-key action endpoint.",
    architecture: "The endpoint delegates to the existing state machine.",
    implementationSteps: ["Select", "Request approval", "Approve"],
    filesAffected: ["src/app/api/v1/planning/sessions/[planId]/actions/route.js"],
    pros: ["One state machine"],
    cons: ["Planning-aware client required"],
    risks: [],
    complexity: "medium",
    compatibility: "OFF keys remain unchanged.",
    acceptanceCriteria: ["Exactly one approval wins"],
    testStrategy: ["Concurrent route calls"],
  }],
  recommendedOptionIndex: 0,
};

const provider = {
  validateCapabilities: vi.fn(async () => ({ structuredOutput: true })),
  generatePlan: vi.fn(async () => ({ plan: output, usage: {}, attempts: 1 })),
  revisePlan: vi.fn(async () => ({ plan: output, usage: {}, attempts: 1 })),
};

function actionRequest(key, planId, body) {
  return new Request(`https://router.example/api/v1/planning/sessions/${planId}/actions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function boot({ approvalRequired = true } = {}) {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete global._projectMemoryWorker;
  vi.resetModules();
  const database = await import("@/lib/db/index.js");
  const projects = await import("@/lib/projectMemory/repository.js");
  const planning = await import("@/lib/planning/service.js");
  const actions = await import("@/app/api/v1/planning/sessions/[planId]/actions/route.js");
  const session = await import("@/app/api/v1/planning/sessions/[planId]/route.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const project = await projects.createProject({ name: "Planning session actions" }, owner);
  const key = await database.createApiKey("Session owner", "session-owner");
  await projects.assignApiKeyToProject(key.id, project.id, owner);
  await database.updateApiKey(key.id, {
    planning: {
      planningEnabled: true,
      planningMode: "ADAPTIVE",
      planningProviderId: "test-provider",
      planningModelId: "test-model",
      approvalRequired,
      contextTokenBudget: 1200,
      planExpiration: 60,
      failurePolicy: "FAIL_CLOSED",
    },
  });
  const plan = await planning.createPlan(project.id, {
    originalRequest: "Create a protected action session",
    providerId: "test-provider",
    modelId: "test-model",
  }, owner, { provider, apiKeyId: key.id });
  return { actions, adapter: await getAdapter(), database, key, plan, project, projects, session };
}

beforeEach(() => {
  delete global._projectApiRateLimits;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-planning-actions-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  if (global._projectMemoryWorker?.timer) clearTimeout(global._projectMemoryWorker.timer);
  delete global._projectMemoryWorker;
  delete global._projectApiRateLimits;
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  vi.restoreAllMocks();
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("API-key planning session actions", () => {
  it("selects an option and commits exactly one concurrent explicit approval", async () => {
    const { actions, adapter, key, plan, session } = await boot({ approvalRequired: false });
    const getResponse = await session.GET(new Request(`https://router.example/api/v1/planning/sessions/${plan.id}`, {
      headers: { authorization: `Bearer ${key.key}` },
    }), { params: Promise.resolve({ planId: plan.id }) });
    const initial = await getResponse.json();
    expect(initial).toMatchObject({ approvalRequired: true, availableActions: expect.arrayContaining(["select_option", "submit_feedback"]) });
    expect(initial.links.actions).toContain(`/${plan.id}/actions`);

    const selectedResponse = await actions.POST(actionRequest(key, plan.id, {
      action: "select_option", expectedVersion: plan.version, optionId: plan.options[0].id,
    }), { params: Promise.resolve({ planId: plan.id }) });
    expect(selectedResponse.status).toBe(200);
    const selected = await selectedResponse.json();
    expect(selected).toMatchObject({ status: "OPTIONS_READY", selectedOptionId: plan.options[0].id });

    const pendingResponse = await actions.POST(actionRequest(key, plan.id, {
      action: "request_approval", expectedVersion: selected.version,
    }), { params: Promise.resolve({ planId: plan.id }) });
    const pending = await pendingResponse.json();
    expect(pending).toMatchObject({ status: "PENDING_APPROVAL", approvalRequired: true });

    const race = await Promise.all([
      actions.POST(actionRequest(key, plan.id, {
        action: "approve", expectedVersion: pending.version, optionId: pending.selectedOptionId,
        scope: "EXECUTE_APPROVED_PLAN", idempotencyKey: "session-approval-race-00000001",
      }), { params: Promise.resolve({ planId: plan.id }) }),
      actions.POST(actionRequest(key, plan.id, {
        action: "approve", expectedVersion: pending.version, optionId: pending.selectedOptionId,
        scope: "EXECUTE_APPROVED_PLAN", idempotencyKey: "session-approval-race-00000002",
      }), { params: Promise.resolve({ planId: plan.id }) }),
    ]);
    expect(race.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(adapter.get("SELECT COUNT(*) AS count FROM planApprovals WHERE planId=?", [plan.id]).count).toBe(1);
    expect(adapter.get("SELECT COUNT(*) AS count FROM planExecutions WHERE planId=?", [plan.id]).count).toBe(0);

    const preflight = actions.OPTIONS();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("rejects cross-key access, unknown fields, and stale action versions", async () => {
    const { actions, database, key, plan, project, projects } = await boot();
    const other = await database.createApiKey("Other key", "other-session-owner");
    await projects.assignApiKeyToProject(other.id, project.id, owner);
    await database.updateApiKey(other.id, { planning: {
      planningEnabled: true, planningMode: "ADAPTIVE", planningProviderId: "test-provider",
      planningModelId: "test-model", approvalRequired: true, contextTokenBudget: 1200,
      planExpiration: 60, failurePolicy: "FAIL_CLOSED",
    } });
    const denied = await actions.POST(actionRequest(other, plan.id, {
      action: "select_option", expectedVersion: plan.version, optionId: plan.options[0].id,
    }), { params: Promise.resolve({ planId: plan.id }) });
    expect(denied.status).toBe(404);

    const ambiguous = await actions.POST(actionRequest(key, plan.id, {
      action: "select_option", expectedVersion: plan.version, optionId: plan.options[0].id, approve: true,
    }), { params: Promise.resolve({ planId: plan.id }) });
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toMatchObject({ error: { code: "PLANNING_ACTION_INVALID" } });

    const selected = await actions.POST(actionRequest(key, plan.id, {
      action: "select_option", expectedVersion: plan.version, optionId: plan.options[0].id,
    }), { params: Promise.resolve({ planId: plan.id }) });
    expect(selected.status).toBe(200);
    const stale = await actions.POST(actionRequest(key, plan.id, {
      action: "submit_feedback", expectedVersion: plan.version, feedback: "This version is stale",
    }), { params: Promise.resolve({ planId: plan.id }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: {
      code: "PLAN_VERSION_CONFLICT", details: { currentVersion: plan.version + 1 },
    } });
  });

  it("rate-limits API-key action abuse and returns retry guidance", async () => {
    const { actions, key, plan } = await boot();
    for (let index = 0; index < 120; index += 1) {
      const response = await actions.POST(actionRequest(key, plan.id, { action: "unknown" }), {
        params: Promise.resolve({ planId: plan.id }),
      });
      expect(response.status).toBe(400);
    }
    const limited = await actions.POST(actionRequest(key, plan.id, { action: "unknown" }), {
      params: Promise.resolve({ planId: plan.id }),
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: { code: "PLANNING_RATE_LIMITED" } });
  }, 10_000);
});
