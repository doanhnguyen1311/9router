import { describe, expect, it } from "vitest";
import { V2_ERROR_CODES, handleV2ProxyRequest } from "../../src/lib/v2Proxy.js";

const simulationBase = process.env.V2_PROXY_SIMULATION_URL;
const describeSimulation = simulationBase ? describe : describe.skip;
const PRIVATE_FIXTURES = [
  "https://should-never-leak.example/v1",
  "fixture-secret-that-must-not-leak",
  "private-upstream",
];

function dependencies() {
  return {
    getV2ProxyConfigByKey: async () => ({
      record: { isActive: true, isExpired: false, v2Proxy: { enabled: true } },
      invalid: false,
      config: {
        upstreamBaseUrl: `${simulationBase}/upstream`,
        upstreamApiKey: "fixture-upstream-key",
      },
    }),
    admitApiKeyRequest: async () => ({ tracked: true, allowed: true }),
    // The production path uses fetchPublic. This local-only test override is
    // necessary because the simulation correctly binds a loopback address,
    // which the production SSRF guard must reject.
    fetchUpstream: (url, init) => fetch(url, init),
  };
}

function request(model, stream = false) {
  return new Request("http://router.test/v2/chat/completions?trace=simulation", {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-facade-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, stream }),
    duplex: "half",
  });
}

describeSimulation("v2 proxy against Postman simulation", () => {
  it("forwards a successful request with replaced authentication", async () => {
    const response = await handleV2ProxyRequest(request("success"), ["chat", "completions"], dependencies());
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("hello through v2");
    expect(response.headers.get("server")).toBeNull();
    expect(response.headers.get("x-private-upstream")).toBeNull();
  });

  it("reduces an upstream HTTP error to one numeric code", async () => {
    const response = await handleV2ProxyRequest(request("error-leak"), ["chat", "completions"], dependencies());
    const payload = await response.text();
    expect(response.status).toBe(502);
    expect(payload).toBe(String(V2_ERROR_CODES.UPSTREAM_FAILURE));
    expect(payload).toMatch(/^\d+$/);
    const responseMetadata = [...response.headers.entries()].join(" ");
    for (const secret of PRIVATE_FIXTURES) {
      expect(payload).not.toContain(secret);
      expect(responseMetadata).not.toContain(secret);
    }
  });

  it("redacts an SSE error event after preserving prior success content", async () => {
    const response = await handleV2ProxyRequest(request("sse-error-leak", true), ["chat", "completions"], dependencies());
    const payload = await response.text();
    expect(payload).toContain("hello");
    expect(payload).toContain(`\n\n${V2_ERROR_CODES.UPSTREAM_FAILURE}\n\n`);
    expect(payload).not.toContain(`data: ${V2_ERROR_CODES.UPSTREAM_FAILURE}`);
    for (const secret of PRIVATE_FIXTURES) expect(payload).not.toContain(secret);
  });
});
