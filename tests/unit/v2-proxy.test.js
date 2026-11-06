import { describe, expect, it, vi } from "vitest";
import {
  V2_ERROR_CODES,
  buildV2UpstreamUrl,
  handleV2ProxyRequest,
} from "../../src/lib/v2Proxy.js";

const FACADE_KEY = "sk-wrapper-secret";
const UPSTREAM_KEY = "sk-upstream-secret";
const UPSTREAM_URL = "https://hidden-upstream.example/v1";

function request({ headers = {}, body = { model: "fixture" }, url = "http://router.test/v2/chat/completions?trace=7" } = {}) {
  return new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${FACADE_KEY}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    duplex: "half",
  });
}

function dependencies(fetchUpstream, overrides = {}) {
  return {
    getV2ProxyConfigByKey: vi.fn(async () => ({
      record: { isActive: true, isExpired: false, v2Proxy: { enabled: true } },
      invalid: false,
      config: { upstreamBaseUrl: UPSTREAM_URL, upstreamApiKey: UPSTREAM_KEY },
    })),
    admitApiKeyRequest: vi.fn(async () => ({ tracked: true, allowed: true })),
    fetchUpstream,
    ...overrides,
  };
}

describe("v2 reverse proxy", () => {
  it("forwards to the hidden v1 base and replaces the facade credential", async () => {
    const fetchUpstream = vi.fn(async (_url, init) => {
      expect(await new Response(init.body).json()).toEqual({ model: "fixture" });
      return new Response(JSON.stringify({ id: "ok", choices: [] }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          server: "secret-upstream-server",
          "x-upstream-url": UPSTREAM_URL,
        },
      });
    });

    const response = await handleV2ProxyRequest(request(), ["chat", "completions"], dependencies(fetchUpstream));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "ok", choices: [] });
    expect(response.headers.get("server")).toBeNull();
    expect(response.headers.get("x-upstream-url")).toBeNull();
    const [target, init, options] = fetchUpstream.mock.calls[0];
    expect(target).toBe("https://hidden-upstream.example/v1/chat/completions?trace=7");
    expect(init.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(init.headers.get("authorization")).not.toContain(FACADE_KEY);
    expect(options).toEqual({ maxRedirects: 0 });
  });

  it("never forwards a facade key carried by x-api-key or the query string", async () => {
    const fetchUpstream = vi.fn(async () => new Response("{}", {
      headers: { "content-type": "application/json" },
    }));
    const req = request({
      headers: { authorization: "", "x-api-key": FACADE_KEY },
      url: `http://router.test/v2/models?key=${FACADE_KEY}&visible=1`,
    });

    await handleV2ProxyRequest(req, ["models"], dependencies(fetchUpstream));

    const [target, init] = fetchUpstream.mock.calls[0];
    expect(target).toBe("https://hidden-upstream.example/v1/models?visible=1");
    expect(init.headers.get("x-api-key")).toBe(UPSTREAM_KEY);
    expect(init.headers.get("authorization")).toBeNull();
    expect(target).not.toContain(FACADE_KEY);
  });

  it("returns only a numeric code for upstream HTTP and JSON-envelope failures", async () => {
    for (const upstreamResponse of [
      new Response(`failure at ${UPSTREAM_URL} with ${UPSTREAM_KEY}`, {
        status: 500,
        headers: { "content-type": "text/html", "x-secret": UPSTREAM_KEY },
      }),
      new Response(JSON.stringify({ error: { message: `${UPSTREAM_URL} ${UPSTREAM_KEY}` } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({ id: "success-shaped", debug: UPSTREAM_URL }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]) {
      const response = await handleV2ProxyRequest(
        request(),
        ["chat", "completions"],
        dependencies(vi.fn(async () => upstreamResponse)),
      );
      const text = await response.text();
      expect(response.status).toBe(502);
      expect(text).toBe(String(V2_ERROR_CODES.UPSTREAM_FAILURE));
      expect(text).toMatch(/^\d+$/);
      expect([...response.headers.entries()].join(" ")).not.toContain(UPSTREAM_KEY);
      expect([...response.headers.entries()].join(" ")).not.toContain(UPSTREAM_URL);
    }
  });

  it("sanitizes error events that arrive after an SSE stream has started", async () => {
    const upstream = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      `event: error\ndata: {"error":{"message":"${UPSTREAM_URL} ${UPSTREAM_KEY}"}}\n\n`,
    ].join("");
    const response = await handleV2ProxyRequest(
      request({ body: { model: "fixture", stream: true } }),
      ["chat", "completions"],
      dependencies(vi.fn(async () => new Response(upstream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }))),
    );

    const text = await response.text();
    expect(text).toContain("hello");
    expect(text).toContain(`\n\n${V2_ERROR_CODES.UPSTREAM_FAILURE}\n\n`);
    expect(text).not.toContain(UPSTREAM_URL);
    expect(text).not.toContain(UPSTREAM_KEY);
    expect(text).not.toContain("event: error");
    expect(text).not.toContain(`data: ${V2_ERROR_CODES.UPSTREAM_FAILURE}`);
  });

  it("uses numeric-only local auth, permission, quota, and internal failures", async () => {
    const cases = [
      {
        request: new Request("http://router.test/v2/models"),
        deps: dependencies(vi.fn()),
        status: 401,
        code: V2_ERROR_CODES.INVALID_API_KEY,
      },
      {
        request: request(),
        deps: dependencies(vi.fn(), {
          getV2ProxyConfigByKey: vi.fn(async () => ({
            record: { isActive: true, isExpired: false, v2Proxy: { enabled: false } },
            config: null,
          })),
        }),
        status: 403,
        code: V2_ERROR_CODES.V2_NOT_ALLOWED,
      },
      {
        request: request(),
        deps: dependencies(vi.fn(), {
          admitApiKeyRequest: vi.fn(async () => ({ tracked: true, allowed: false, exceeded: "requests" })),
        }),
        status: 429,
        code: V2_ERROR_CODES.QUOTA_EXCEEDED,
      },
      {
        request: request(),
        deps: dependencies(vi.fn(), {
          getV2ProxyConfigByKey: vi.fn(async () => { throw new Error(`${UPSTREAM_URL} ${UPSTREAM_KEY}`); }),
        }),
        status: 500,
        code: V2_ERROR_CODES.INTERNAL_FAILURE,
      },
    ];

    for (const item of cases) {
      const response = await handleV2ProxyRequest(item.request, ["models"], item.deps);
      expect(response.status).toBe(item.status);
      expect(await response.text()).toBe(String(item.code));
    }
  });

  it("keeps path segments under the configured upstream base", () => {
    expect(buildV2UpstreamUrl(UPSTREAM_URL, ["models"], "http://router/v2/models"))
      .toBe("https://hidden-upstream.example/v1/models");
    expect(() => buildV2UpstreamUrl(UPSTREAM_URL, ["..", "admin"], "http://router/v2/x"))
      .toThrow();
  });
});
