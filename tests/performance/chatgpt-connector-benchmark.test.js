import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const owner = { principalId: "local-admin", displayName: "Connector benchmark", admin: true };
let tempDir;
let modules;
const originalDataDir = process.env.DATA_DIR;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-chatgpt-benchmark-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._projectMemoryWorker;
  vi.resetModules();
  const projects = await import("@/lib/projectMemory/repository.js");
  const connector = await import("@/lib/chatgptConnector/repository.js");
  const security = await import("@/lib/chatgptConnector/security.js");
  const mcp = await import("@/lib/chatgptConnector/mcp.js");
  const rateLimit = await import("@/lib/chatgptConnector/rateLimit.js");
  modules = { projects, connector, security, mcp, rateLimit };
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("ChatGPT connector performance", () => {
  it("measures authenticated stateless MCP control-plane latency", async () => {
    modules.rateLimit.resetConnectorRateLimits();
    const project = await modules.projects.createProject({ name: "Connector benchmark" }, owner);
    const created = await modules.connector.createConnector(project.id, { allowPlanSubmit: false }, owner);
    const client = await modules.connector.registerOauthClient({
      clientName: "Benchmark",
      redirectUris: ["https://chatgpt.com/aip/callback"],
    });
    const verifier = "benchmark-pkce-verifier-012345678901234567890123456789";
    const authRequest = await modules.connector.createOauthRequest({
      clientId: client.id,
      redirectUri: client.redirectUris[0],
      codeChallenge: modules.security.base64UrlSha256(verifier),
      requestedScopes: created.connector.allowedScopes,
    });
    const authorization = await modules.connector.authorizePairing(authRequest.id, created.pairingCode);
    const tokens = await modules.connector.exchangeAuthorizationCode({
      code: authorization.code,
      clientId: client.id,
      redirectUri: client.redirectUris[0],
      codeVerifier: verifier,
    });

    const durations = [];
    for (let index = 0; index < 50; index += 1) {
      const request = new Request("http://localhost/api/v1/connectors/chatgpt/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: index, method: "ping", params: {} }),
      });
      const started = performance.now();
      const response = await modules.mcp.handleMcpPost(request);
      durations.push(performance.now() - started);
      expect(response.status).toBe(200);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const metrics = {
      iterations: durations.length,
      authenticatedPingAverageMs: Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(2)),
      authenticatedPingP95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2)),
    };
    console.log("CHATGPT_CONNECTOR_BENCHMARK", JSON.stringify(metrics));
    expect(metrics.authenticatedPingP95Ms).toBeLessThan(250);
  });
});
