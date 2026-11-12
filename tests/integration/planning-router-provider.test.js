import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
let server;
const originalDataDir = process.env.DATA_DIR;

const structuredPlan = {
  interpretedObjective: "Exercise the real router planning adapter",
  assumptions: [],
  missingInformation: [],
  constraints: ["Use only the local test provider"],
  affectedModules: ["src/lib/planning/routerProvider.js"],
  risks: [],
  options: [{
    name: "Local provider path",
    summary: "Route the planning prompt through the normal executor.",
    architecture: "Planning provider delegates to the existing single-model chat pipeline.",
    implementationSteps: ["Resolve model", "Select credential", "Call local upstream", "Validate JSON"],
    filesAffected: ["src/lib/planning/routerProvider.js"],
    pros: ["Uses the production path"],
    cons: [],
    risks: [],
    complexity: "low",
    compatibility: "No external network or legacy request change.",
    acceptanceCriteria: ["Structured plan is returned"],
    testStrategy: ["Local HTTP integration"],
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-planner-router-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  server = null;
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("RouterPlanningProvider production transport", () => {
  it("uses a configured provider node end-to-end without external network", async () => {
    let received;
    server = await listenLocal((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        received = {
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "local-planning-response",
          object: "chat.completion",
          model: "planner-model",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(structuredPlan) } }],
          usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
        }));
      });
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const database = await import("@/lib/db/index.js");
    const node = await database.createProviderNode({
      id: "openai-compatible-chat-planning-local",
      type: "openai-compatible",
      prefix: "planning-local",
      apiType: "chat",
      baseUrl,
      name: "Planning local test",
    });
    await database.createProviderConnection({
      provider: node.id,
      authType: "apikey",
      name: "Planning local key",
      apiKey: "local-test-key",
      allowOverwrite: false,
      providerSpecificData: {
        prefix: node.prefix,
        apiType: node.apiType,
        baseUrl: node.baseUrl,
        nodeName: node.name,
      },
    });

    const { RouterPlanningProvider } = await import("@/lib/planning/routerProvider.js");
    const provider = new RouterPlanningProvider({ maxAttempts: 1 });
    const result = await provider.generatePlan({
      providerId: "planning-local",
      modelId: "planner-model",
      originalRequest: "Prove the production provider path",
      context: { content: "[BEGIN 9ROUTER PROJECT CONTEXT]\nLocal only\n[END 9ROUTER PROJECT CONTEXT]" },
      timeoutMs: 10_000,
    });

    expect(result.plan.interpretedObjective).toBe(structuredPlan.interpretedObjective);
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(30);
    expect(result.usage.outputTokens).toBe(20);
    expect(result.usage.totalTokens).toBe(result.usage.inputTokens + result.usage.outputTokens);
    expect(received.url).toBe("/v1/chat/completions");
    expect(received.authorization).toBe("Bearer local-test-key");
    expect(received.body).toMatchObject({ model: "planner-model", stream: false });
    expect(received.body.messages[0].content).toContain("planning layer of 9Router");
  });
});
