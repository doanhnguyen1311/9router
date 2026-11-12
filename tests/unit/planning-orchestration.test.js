import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
let bootSequence = 0;
const originalDataDir = process.env.DATA_DIR;
const owner = { principalId: "local-admin", displayName: "Local Admin", admin: true };

const structuredPlan = {
  interpretedObjective: "Automatically plan the intercepted engineering request",
  assumptions: ["The assigned Project is authoritative"],
  missingInformation: [],
  constraints: ["Do not execute before approval"],
  affectedModules: ["src/lib/planning/orchestration.js"],
  risks: [],
  options: [
    {
      name: "Safe automatic plan",
      summary: "Create options before contacting the requested execution model.",
      architecture: "Inference gate delegates to the isolated planning service.",
      implementationSteps: ["Authenticate key", "Build context", "Return options"],
      filesAffected: ["src/sse/handlers/chat.js"],
      pros: ["Explicit approval boundary"],
      cons: ["Requires a planning-aware client"],
      risks: [],
      complexity: "medium",
      compatibility: "OFF keys retain the legacy response path.",
      acceptanceCriteria: ["The execution model is not called"],
      testStrategy: ["Request orchestration tests"],
    },
    {
      name: "Broader refactor",
      summary: "Move all inference dispatch into a task protocol.",
      architecture: "A durable task layer owns every provider call.",
      implementationSteps: ["Add task layer"],
      filesAffected: ["src/sse/handlers/chat.js"],
      pros: ["Unified lifecycle"],
      cons: ["Larger compatibility surface"],
      risks: ["Migration complexity"],
      complexity: "high",
      compatibility: "Requires client adaptation.",
      acceptanceCriteria: ["Legacy requests still work"],
      testStrategy: ["Full regression"],
    },
  ],
  recommendedOptionIndex: 0,
};

function provider() {
  return {
    validateCapabilities: vi.fn(async () => ({ structuredOutput: true })),
    generatePlan: vi.fn(async () => ({
      plan: structuredPlan,
      usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
      attempts: 1,
    })),
    revisePlan: vi.fn(),
  };
}

async function boot({ mode = "ADAPTIVE", failurePolicy = "FAIL_CLOSED", assign = true } = {}) {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete global._projectMemoryWorker;
  vi.resetModules();
  const database = await import("@/lib/db/index.js");
  const projects = await import("@/lib/projectMemory/repository.js");
  const orchestration = await import("@/lib/planning/orchestration.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  bootSequence += 1;
  const project = await projects.createProject({ name: `Automatic planning ${mode} ${bootSequence}` }, owner);
  const key = await database.createApiKey(`Planning ${mode} ${bootSequence}`, `machine-${mode.toLowerCase()}-${bootSequence}`);
  if (assign) await projects.assignApiKeyToProject(key.id, project.id, owner);
  const keyRecord = await database.updateApiKey(key.id, {
    planning: {
      planningEnabled: mode !== "OFF",
      planningMode: mode,
      planningProviderId: "openai",
      planningModelId: "planner-model",
      approvalRequired: true,
      contextTokenBudget: 1200,
      planExpiration: 60,
      failurePolicy,
    },
  });
  return { database, projects, orchestration, adapter: await getAdapter(), project, key, keyRecord };
}

function request(key, {
  idempotency = "automatic-plan-request-0001",
  planning = null,
  body = { model: "codex/gpt-5", messages: [{ role: "user", content: "Implement automatic planning" }] },
} = {}) {
  const headers = { authorization: `Bearer ${key.key}`, "content-type": "application/json" };
  if (idempotency) headers["idempotency-key"] = idempotency;
  if (planning) headers["x-9router-planning"] = planning;
  return new Request("https://router.example/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  bootSequence = 0;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-planning-orchestration-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  if (global._projectMemoryWorker?.timer) clearTimeout(global._projectMemoryWorker.timer);
  delete global._projectMemoryWorker;
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  vi.restoreAllMocks();
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Automatic planning request orchestration", () => {
  it("intercepts ADAPTIVE requests, returns multiple options, and reuses an idempotent Plan", async () => {
    const { database, orchestration, adapter, project, key, keyRecord } = await boot();
    const selectedProvider = provider();
    const first = await orchestration.orchestratePlanningRequest({
      request: request(key),
      body: { model: "codex/gpt-5", messages: [{ role: "user", content: "Implement automatic planning" }] },
      keyRecord,
      sessionId: "client-session-a",
      endpoint: "/v1/chat/completions",
      provider: selectedProvider,
    });
    expect(first.handled).toBe(true);
    expect(first.response.status).toBe(202);
    const firstBody = await first.response.json();
    expect(firstBody).toMatchObject({
      object: "9router.planning_session",
      projectId: project.id,
      apiKeyId: key.id,
      status: "OPTIONS_READY",
      approvalRequired: true,
    });
    expect(firstBody.options).toHaveLength(2);
    expect(firstBody.recommendedOptionId).toBe(firstBody.options[0].id);
    expect(firstBody.availableActions).toContain("select_option");
    expect(selectedProvider.generatePlan).toHaveBeenCalledTimes(1);

    const second = await orchestration.orchestratePlanningRequest({
      request: request(key),
      body: { model: "codex/gpt-5", messages: [{ role: "user", content: "A changed retry body must not replace the first plan" }] },
      keyRecord,
      sessionId: "client-session-a",
      endpoint: "/v1/chat/completions",
      provider: selectedProvider,
    });
    const secondBody = await second.response.json();
    expect(secondBody.planId).toBe(firstBody.planId);
    expect(secondBody.originalRequest).toBe(firstBody.originalRequest);
    expect(selectedProvider.generatePlan).toHaveBeenCalledTimes(1);

    const binding = adapter.get("SELECT * FROM planningRequestBindings WHERE planId=?", [firstBody.planId]);
    expect(binding).toMatchObject({ projectId: project.id, apiKeyId: key.id, sourceEndpoint: "/v1/chat/completions" });
    expect(binding.requestKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.clientSessionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(binding)).not.toContain("automatic-plan-request-0001");
    expect(adapter.all("PRAGMA foreign_key_check")).toEqual([]);

    const exported = await database.exportDb();
    expect(exported.projectMemory.planningRequestBindings).toHaveLength(1);
    await database.importDb(exported);
    expect(adapter.get("SELECT planId FROM planningRequestBindings").planId).toBe(firstBody.planId);
    expect(adapter.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("keeps MANUAL requests on the legacy path unless explicitly requested", async () => {
    const { orchestration, key, keyRecord } = await boot({ mode: "MANUAL" });
    const selectedProvider = provider();
    const body = { model: "codex/gpt-5", messages: [{ role: "user", content: "Plan only when requested" }] };
    const ordinary = await orchestration.orchestratePlanningRequest({
      request: request(key, { idempotency: null }), body, keyRecord, provider: selectedProvider,
    });
    expect(ordinary).toMatchObject({ handled: false, reason: "manual-signal-required" });
    expect(selectedProvider.generatePlan).not.toHaveBeenCalled();

    const explicit = await orchestration.orchestratePlanningRequest({
      request: request(key, { idempotency: "manual-plan-0001", planning: "plan" }),
      body,
      keyRecord,
      provider: selectedProvider,
    });
    expect(explicit.handled).toBe(true);
    expect((await explicit.response.json()).status).toBe("OPTIONS_READY");
    expect(selectedProvider.generatePlan).toHaveBeenCalledTimes(1);
  });

  it("keeps OFF requests on the legacy path even when a client sends the planning header", async () => {
    const { orchestration, key, keyRecord } = await boot({ mode: "OFF" });
    const selectedProvider = provider();
    const body = { model: "codex/gpt-5", messages: [{ role: "user", content: "Do not plan this request" }] };
    const result = await orchestration.orchestratePlanningRequest({
      request: request(key, { idempotency: null, planning: "plan", body }),
      body,
      keyRecord,
      provider: selectedProvider,
    });
    expect(result).toMatchObject({ handled: false, reason: "disabled" });
    expect(selectedProvider.generatePlan).not.toHaveBeenCalled();
  });

  it("extracts user intent but skips tool-only continuations", async () => {
    const { orchestration } = await boot();
    expect(orchestration.extractPlanningRequest({ input: "Change the API" })).toMatchObject({ hasUserInput: true, text: "Change the API" });
    expect(orchestration.extractPlanningRequest({
      input: [{ role: "user", content: [{ type: "input_text", text: "Change Responses API" }] }],
    })).toMatchObject({ hasUserInput: true, text: "Change Responses API" });
    expect(orchestration.extractPlanningRequest({
      contents: [{ role: "user", parts: [{ text: "Change Gemini API" }] }],
    })).toMatchObject({ hasUserInput: true, text: "Change Gemini API" });
    expect(orchestration.extractPlanningRequest({
      messages: [{ role: "tool", content: "command output" }],
    })).toMatchObject({ hasUserInput: false, text: "" });
    expect(orchestration.extractPlanningRequest({
      messages: [
        { role: "user", content: "Earlier task" },
        { role: "assistant", content: "Calling a tool" },
        { role: "tool", content: "command output" },
      ],
    })).toMatchObject({ hasUserInput: false, text: "" });
    expect(orchestration.extractPlanningRequest({
      input: [
        { role: "user", content: [{ type: "input_text", text: "Earlier task" }] },
        { type: "function_call_output", call_id: "call-1", output: "done" },
      ],
    })).toMatchObject({ hasUserInput: false, text: "" });
  });

  it("fails closed without a Project and obeys the provider failure policy", async () => {
    const unassigned = await boot({ assign: false });
    const closed = await unassigned.orchestration.orchestratePlanningRequest({
      request: request(unassigned.key),
      body: { messages: [{ role: "user", content: "Plan without a project" }] },
      keyRecord: unassigned.keyRecord,
      provider: provider(),
    });
    expect(closed.response.status).toBe(409);
    expect(await closed.response.json()).toMatchObject({ error: { code: "PLANNING_PROJECT_REQUIRED" } });

    const failClosed = await boot({ failurePolicy: "FAIL_CLOSED" });
    const brokenProvider = provider();
    brokenProvider.generatePlan.mockRejectedValue(Object.assign(new Error("planner unavailable"), {
      code: "PLANNING_UPSTREAM_ERROR", status: 502,
    }));
    const failed = await failClosed.orchestration.orchestratePlanningRequest({
      request: request(failClosed.key, { idempotency: "provider-failure-closed" }),
      body: { messages: [{ role: "user", content: "Plan safely" }] },
      keyRecord: failClosed.keyRecord,
      provider: brokenProvider,
    });
    expect(failed.handled).toBe(true);
    expect(failed.response.status).toBe(502);
    expect(failClosed.adapter.get("SELECT status FROM executionPlans").status).toBe("FAILED");

    const failOpen = await boot({ failurePolicy: "LEGACY_PATH" });
    const fallbackProvider = provider();
    fallbackProvider.generatePlan.mockRejectedValue(Object.assign(new Error("planner unavailable"), {
      code: "PLANNING_UPSTREAM_ERROR", status: 502,
    }));
    const fallback = await failOpen.orchestration.orchestratePlanningRequest({
      request: request(failOpen.key, { idempotency: "provider-failure-open" }),
      body: { messages: [{ role: "user", content: "Continue only by policy" }] },
      keyRecord: failOpen.keyRecord,
      provider: fallbackProvider,
    });
    expect(fallback).toMatchObject({ handled: false, reason: "provider-fallback" });
    expect(fallback.fallbackError.code).toBe("PLANNING_UPSTREAM_ERROR");
  });

  it("allows only the originating API Key to read an automatic planning session", async () => {
    const { database, projects, orchestration, project, key, keyRecord } = await boot();
    const created = await orchestration.orchestratePlanningRequest({
      request: request(key, { idempotency: "session-read-owner" }),
      body: { messages: [{ role: "user", content: "Create a protected session" }] },
      keyRecord,
      provider: provider(),
    });
    const planId = (await created.response.json()).planId;
    const route = await import("@/app/api/v1/planning/sessions/[planId]/route.js");
    const allowed = await route.GET(new Request(`https://router.example/api/v1/planning/sessions/${planId}`, {
      headers: { authorization: `Bearer ${key.key}` },
    }), { params: Promise.resolve({ planId }) });
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).planId).toBe(planId);

    const other = await database.createApiKey("Other planning key", "other-machine");
    await projects.assignApiKeyToProject(other.id, project.id, owner);
    await database.updateApiKey(other.id, { planning: keyRecord.planning });
    const denied = await route.GET(new Request(`https://router.example/api/v1/planning/sessions/${planId}`, {
      headers: { authorization: `Bearer ${other.key}` },
    }), { params: Promise.resolve({ planId }) });
    expect(denied.status).toBe(404);
  });
});
