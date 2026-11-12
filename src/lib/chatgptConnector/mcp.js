import { NextResponse } from "next/server";
import {
  CHATGPT_CONNECTOR_LIMITS,
  MCP_PROTOCOL_VERSION,
  UNTRUSTED_PROJECT_NOTICE,
  connectorError,
} from "./constants.js";
import { consumeConnectorRateLimit } from "./rateLimit.js";
import {
  authenticateAccessToken,
  recordConnectorAudit,
} from "./repository.js";
import { executeConnectorTool, visibleTools } from "./tools.js";
import { sanitizeConnectorData } from "./security.js";

const MCP_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
};

function jsonRpc(id, result) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result }, { headers: MCP_HEADERS });
}

function rpcError(id, code, message, data = undefined, status = 200) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } },
    { status, headers: MCP_HEADERS },
  );
}

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
}

function clientIp(request) {
  return (request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]
    || "unknown").trim().slice(0, 200);
}

async function readMcpJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > CHATGPT_CONNECTOR_LIMITS.maxRequestBytes) throw connectorError("MCP_BODY_TOO_LARGE", "MCP request is too large", 413);
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > CHATGPT_CONNECTOR_LIMITS.maxRequestBytes) {
    throw connectorError("MCP_BODY_TOO_LARGE", "MCP request is too large", 413);
  }
  try { return JSON.parse(raw); }
  catch { throw connectorError("MCP_INVALID_JSON", "Invalid JSON-RPC body", 400); }
}

function toolDescriptor(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  };
}

export async function handleMcpPost(request, options = {}) {
  const ip = clientIp(request);
  const preAuthBudget = consumeConnectorRateLimit(`mcp-preauth:${ip}`, {
    limit: CHATGPT_CONNECTOR_LIMITS.mcpUnauthenticatedRequestsPerMinute,
  });
  if (!preAuthBudget.allowed) {
    return NextResponse.json(
      { error: "rate_limited", error_description: "MCP request rate limit exceeded" },
      { status: 429, headers: { ...MCP_HEADERS, "Retry-After": String(preAuthBudget.retryAfter) } },
    );
  }
  let auth;
  try {
    auth = await authenticateAccessToken(bearerToken(request));
  } catch (error) {
    const origin = new URL(request.url).origin;
    const status = error.status === 403 ? 403 : 401;
    const headers = {
      ...MCP_HEADERS,
      ...(status === 401 ? {
        "WWW-Authenticate": `Bearer realm="9router-chatgpt", resource_metadata="${origin}/.well-known/oauth-protected-resource/api/v1/connectors/chatgpt/mcp"`,
      } : {}),
    };
    return NextResponse.json({ error: status === 401 ? "unauthorized" : "forbidden", error_description: error.message }, { status, headers });
  }
  const budget = consumeConnectorRateLimit(`mcp:${auth.tokenId}:${ip}`, {
    limit: CHATGPT_CONNECTOR_LIMITS.mcpRequestsPerMinute,
  });
  if (!budget.allowed) {
    return NextResponse.json(
      { error: "rate_limited", error_description: "MCP request rate limit exceeded" },
      { status: 429, headers: { ...MCP_HEADERS, "Retry-After": String(budget.retryAfter) } },
    );
  }
  let body;
  try { body = await readMcpJson(request); }
  catch (error) { return rpcError(null, -32700, error.message, undefined, error.status || 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body?.id, -32600, "Invalid JSON-RPC request", undefined, 400);
  }
  const { id, method, params = {} } = body;
  if (method === "initialize") {
    await recordConnectorAudit(auth, "MCP_INITIALIZED", { clientInfo: params.clientInfo || null });
    return jsonRpc(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "9Router ChatGPT Project Connector", version: "1.0.0" },
      instructions: UNTRUSTED_PROJECT_NOTICE,
    });
  }
  if (method === "notifications/initialized") return new Response(null, { status: 202, headers: MCP_HEADERS });
  if (method === "ping") return jsonRpc(id, {});
  if (method === "tools/list") return jsonRpc(id, { tools: visibleTools(auth).map(toolDescriptor) });
  if (method === "tools/call") {
    const name = params?.name;
    if (typeof name !== "string" || !name) return rpcError(id, -32602, "Tool name is required");
    const started = Date.now();
    try {
      const output = await executeConnectorTool(name, params.arguments || {}, auth, options);
      await recordConnectorAudit(auth, "MCP_TOOL_CALLED", { name, ok: true, durationMs: Date.now() - started });
      return jsonRpc(id, {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
        isError: false,
      });
    } catch (error) {
      await recordConnectorAudit(auth, "MCP_TOOL_CALLED", {
        name,
        ok: false,
        code: error.code || "MCP_TOOL_FAILED",
        durationMs: Date.now() - started,
      });
      const safeMessage = Number(error.status) >= 500 ? "Tool execution failed" : String(error.message || "Tool execution failed").slice(0, 1000);
      const errorData = sanitizeConnectorData({
        notice: UNTRUSTED_PROJECT_NOTICE,
        error: { code: error.code || "MCP_TOOL_FAILED", message: safeMessage, ...(error.details ? { details: error.details } : {}) },
      });
      return jsonRpc(id, {
        content: [{ type: "text", text: JSON.stringify(errorData) }],
        structuredContent: errorData,
        isError: true,
      });
    }
  }
  return rpcError(id, -32601, "Method not found");
}

export function handleMcpUnsupportedMethod() {
  return rpcError(null, -32000, "Method not allowed. Use POST.", undefined, 405);
}

export const __test__ = { bearerToken, readMcpJson, clientIp, toolDescriptor };
