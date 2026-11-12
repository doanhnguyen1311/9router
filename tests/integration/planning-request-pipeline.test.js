import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
let server;
const originalDataDir = process.env.DATA_DIR;
const owner = { principalId: "local-admin", displayName: "Local Admin", admin: true };

const structuredPlan = {
  interpretedObjective: "Plan before the requested execution model runs",
  assumptions: [],
  missingInformation: [],
  constraints: ["The execution model must remain untouched"],
  affectedModules: ["src/sse/handlers/chat.js"],
  risks: [],
  options: [{
    name: "Intercept before execution",
    summary: "Return a durable planning session from the inference endpoint.",
    architecture: "The authenticated request gate invokes the isolated Planning Provider.",
    implementationSteps: ["Resolve key", "Generate options", "Return 202"],
    filesAffected: ["src/sse/handlers/chat.js"],
    pros: ["No unapproved execution"],
    cons: ["Requires a planning-aware client"],
    risks: [],
    complexity: "medium",
    compatibility: "Only opted-in keys receive the extension response.",
    acceptanceCriteria: ["The nonexistent execution model is never resolved upstream"],
    testStrategy: ["Local upstream integration test"],
  }],
  recommendedOptionIndex: 0,
};

function listenLocal(handler) {
  return new Promise((resolve, reject) => {
    const instance = http.createServer(handler);
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-planning-request-pipeline-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._projectMemoryWorker;
  vi.resetModules();
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  server = null;
  if (global._projectMemoryWorker?.timer) clearTimeout(global._projectMemoryWorker.timer);
  delete global._projectMemoryWorker;
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Planning-enabled inference request pipeline", () => {
  it("returns planning options before contacting the requested execution model", async () => {
    const receivedModels = [];
    server = await listenLocal((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        receivedModels.push(body.model);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "automatic-planning-response",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(structuredPlan) } }],
          usage: { prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 },
        }));
      });
    });

    const database = await import("@/lib/db/index.js");
    const projects = await import("@/lib/projectMemory/repository.js");
    const node = await database.createProviderNode({
      id: "openai-compatible-auto-planning-local",
      type: "openai-compatible",
      prefix: "planning-auto",
      apiType: "chat",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      name: "Automatic planning local test",
    });
    await database.createProviderConnection({
      provider: node.id,
      authType: "apikey",
      name: "Automatic planning key",
      apiKey: "local-planner-key",
      allowOverwrite: false,
      providerSpecificData: {
        prefix: node.prefix,
        apiType: node.apiType,
        baseUrl: node.baseUrl,
        nodeName: node.name,
      },
    });

    const project = await projects.createProject({ name: "Automatic request integration" }, owner);
    const key = await database.createApiKey("Automatic request", "automatic-request-machine");
    await projects.assignApiKeyToProject(key.id, project.id, owner);
    await database.updateApiKey(key.id, {
      planning: {
        planningEnabled: true,
        planningMode: "ADAPTIVE",
        planningProviderId: "planning-auto",
        planningModelId: "planner-model",
        approvalRequired: true,
        contextTokenBudget: 900,
        planExpiration: 60,
        failurePolicy: "FAIL_CLOSED",
      },
    });

    const { handleChat } = await import("@/sse/handlers/chat.js");
    const response = await handleChat(new Request("https://router.example/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.key}`,
        "content-type": "application/json",
        "idempotency-key": "pipeline-integration-request-0001",
      },
      body: JSON.stringify({
        model: "provider-that-does-not-exist/execution-model",
        stream: true,
        messages: [{ role: "user", content: "Implement the approved feature" }],
      }),
    }));

    expect(response.status).toBe(202);
    const payload = await response.json();
    expect(payload).toMatchObject({
      object: "9router.planning_session",
      projectId: project.id,
      apiKeyId: key.id,
      status: "OPTIONS_READY",
    });
    expect(payload.options).toHaveLength(1);

    const ollamaRoute = await import("@/app/api/v1/api/chat/route.js");
    const ollamaResponse = await ollamaRoute.POST(new Request("https://router.example/v1/api/chat", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.key}`,
        "content-type": "application/json",
        "idempotency-key": "pipeline-ollama-request-0001",
      },
      body: JSON.stringify({
        model: "provider-that-does-not-exist/execution-model",
        stream: true,
        messages: [{ role: "user", content: "Plan the Ollama request" }],
      }),
    }));
    expect(ollamaResponse.status).toBe(202);
    expect(await ollamaResponse.json()).toMatchObject({ object: "9router.planning_session", status: "OPTIONS_READY" });

    const geminiRoute = await import("@/app/api/v1beta/models/[...path]/route.js");
    const geminiResponse = await geminiRoute.POST(new Request(
      "https://router.example/v1beta/models/provider-that-does-not-exist/execution-model:generateContent",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.key}`,
          "content-type": "application/json",
          "idempotency-key": "pipeline-gemini-request-0001",
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Plan the Gemini request" }] }] }),
      },
    ), { params: Promise.resolve({ path: ["provider-that-does-not-exist", "execution-model:generateContent"] }) });
    expect(geminiResponse.status).toBe(202);
    expect(await geminiResponse.json()).toMatchObject({ object: "9router.planning_session", status: "OPTIONS_READY" });

    const actionsRoute = await import("@/app/api/v1/planning/sessions/[planId]/actions/route.js");
    const invoke = (planId, action) => actionsRoute.POST(new Request(
      `https://router.example/api/v1/planning/sessions/${planId}/actions`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
        body: JSON.stringify(action),
      },
    ), { params: Promise.resolve({ planId }) });

    const revisedResponse = await invoke(payload.planId, {
      action: "revise", expectedVersion: payload.version, feedback: "Make the approval boundary explicit",
    });
    expect(revisedResponse.status).toBe(200);
    const revised = await revisedResponse.json();
    expect(revised).toMatchObject({ status: "OPTIONS_READY", revision: 2 });

    const selected = await (await invoke(payload.planId, {
      action: "select_option", expectedVersion: revised.version, optionId: revised.options[0].id,
    })).json();
    const pending = await (await invoke(payload.planId, {
      action: "request_approval", expectedVersion: selected.version,
    })).json();
    const approvedResponse = await invoke(payload.planId, {
      action: "approve", expectedVersion: pending.version, optionId: pending.selectedOptionId,
      scope: "EXECUTE_APPROVED_PLAN", idempotencyKey: "pipeline-approval-nonce-00000001",
    });
    expect(approvedResponse.status).toBe(200);
    expect(await approvedResponse.json()).toMatchObject({ status: "APPROVED", approvalRequired: true });

    const { getAdapter } = await import("@/lib/db/driver.js");
    expect((await getAdapter()).get("SELECT COUNT(*) AS count FROM planExecutions WHERE planId=?", [payload.planId]).count).toBe(0);
    expect(receivedModels).toEqual(["planner-model", "planner-model", "planner-model", "planner-model"]);
  }, 30_000);
});
