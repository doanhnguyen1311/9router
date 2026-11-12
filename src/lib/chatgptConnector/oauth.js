import { NextResponse } from "next/server";
import {
  CHATGPT_CONNECTOR_LIMITS,
  CHATGPT_CONNECTOR_READ_SCOPES,
  CHATGPT_CONNECTOR_SCOPES,
  connectorError,
} from "./constants.js";
import { consumeConnectorRateLimit } from "./rateLimit.js";
import {
  authorizePairing,
  createOauthRequest,
  exchangeAuthorizationCode,
  registerOauthClient,
  revokeOauthToken,
  rotateRefreshToken,
} from "./repository.js";
import { validateRedirectUri } from "./security.js";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

function originFor(request) {
  const configured = String(process.env.CHATGPT_CONNECTOR_BASE_URL || "").trim().replace(/\/$/, "");
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url.origin;
    } catch { /* fall through to the request origin */ }
  }
  return new URL(request.url).origin;
}

function endpointSet(request) {
  const origin = originFor(request);
  return {
    origin,
    mcp: `${origin}/api/v1/connectors/chatgpt/mcp`,
    authorize: `${origin}/api/v1/connectors/chatgpt/oauth/authorize`,
    token: `${origin}/api/v1/connectors/chatgpt/oauth/token`,
    register: `${origin}/api/v1/connectors/chatgpt/oauth/register`,
    revoke: `${origin}/api/v1/connectors/chatgpt/oauth/revoke`,
  };
}

function oauthIp(request) {
  return (request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]
    || "unknown").trim().slice(0, 200);
}

function consumeOauthBudget(request, operation) {
  const budget = consumeConnectorRateLimit(`oauth:${operation}:${oauthIp(request)}`, {
    limit: CHATGPT_CONNECTOR_LIMITS.oauthRequestsPerMinute,
  });
  if (!budget.allowed) {
    const error = connectorError("OAUTH_RATE_LIMIT", "OAuth request rate limit exceeded", 429);
    error.retryAfter = budget.retryAfter;
    throw error;
  }
}

async function readLimited(request, type) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > CHATGPT_CONNECTOR_LIMITS.maxRequestBytes) throw connectorError("OAUTH_BODY_TOO_LARGE", "Request body is too large", 413);
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > CHATGPT_CONNECTOR_LIMITS.maxRequestBytes) {
    throw connectorError("OAUTH_BODY_TOO_LARGE", "Request body is too large", 413);
  }
  if (type === "form") return Object.fromEntries(new URLSearchParams(raw));
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw connectorError("OAUTH_INVALID_JSON", "Invalid JSON body", 400); }
}

function parseScopes(value) {
  if (String(value || "").length > 1000) throw connectorError("OAUTH_INVALID_SCOPE", "Requested scope is too large", 400);
  const scopes = String(value || "").split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  const effective = scopes.length ? [...new Set(scopes)] : [...CHATGPT_CONNECTOR_READ_SCOPES];
  if (effective.some((scope) => !CHATGPT_CONNECTOR_SCOPES.includes(scope))) {
    throw connectorError("OAUTH_INVALID_SCOPE", "One or more requested scopes are unsupported", 400);
  }
  return effective;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function authorizePage({ requestId, clientName, error = "" }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ChatGPT to 9Router</title><style>
body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#161616;background:#fafafa}
main{background:white;border:1px solid #ddd;border-radius:14px;padding:1.5rem}label{display:block;font-weight:600;margin:.8rem 0 .35rem}
input{box-sizing:border-box;width:100%;padding:.75rem;font:inherit;text-transform:uppercase;letter-spacing:.12em}button{margin-top:1rem;padding:.75rem 1rem;font:inherit;font-weight:700}
.error{color:#a40000}.note{color:#555;font-size:.92rem}</style></head><body><main>
<h1>Connect to 9Router</h1><p>${escapeHtml(clientName || "ChatGPT")} is requesting scoped access to one Project.</p>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
<label for="pairing_code">One-time pairing code</label><input id="pairing_code" name="pairing_code" maxlength="9" autocomplete="one-time-code" required>
<button type="submit">Authorize</button></form>
<p class="note">The code expires after five minutes. This grants only the Project and scopes selected in 9Router.</p>
</main></body></html>`;
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      ...NO_STORE,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

export function authorizationServerMetadata(request) {
  const endpoints = endpointSet(request);
  return {
    issuer: endpoints.origin,
    authorization_endpoint: endpoints.authorize,
    token_endpoint: endpoints.token,
    registration_endpoint: endpoints.register,
    revocation_endpoint: endpoints.revoke,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: CHATGPT_CONNECTOR_SCOPES,
  };
}

export function protectedResourceMetadata(request) {
  const endpoints = endpointSet(request);
  return {
    resource: endpoints.mcp,
    authorization_servers: [endpoints.origin],
    scopes_supported: CHATGPT_CONNECTOR_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "9Router ChatGPT Project Connector",
  };
}

export async function handleClientRegistration(request) {
  consumeOauthBudget(request, "register");
  const body = await readLimited(request, "json");
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length < 1 || body.redirect_uris.length > 10) {
    throw connectorError("OAUTH_REDIRECT_INVALID", "redirect_uris must contain between 1 and 10 entries", 400);
  }
  const redirectUris = [...new Set(body.redirect_uris.map(validateRedirectUri))];
  if (redirectUris.includes(null) || redirectUris.length !== body.redirect_uris.length) {
    throw connectorError("OAUTH_REDIRECT_INVALID", "Every redirect URI must be unique HTTPS or loopback HTTP", 400);
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
    throw connectorError("OAUTH_CLIENT_AUTH_UNSUPPORTED", "Only public PKCE clients are supported", 400);
  }
  const client = await registerOauthClient({ clientName: body.client_name, redirectUris });
  return {
    client_id: client.id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.clientName || undefined,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

export async function beginAuthorization(request) {
  consumeOauthBudget(request, "authorize");
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id") || "";
  const redirectUri = validateRedirectUri(url.searchParams.get("redirect_uri"));
  const responseType = url.searchParams.get("response_type");
  const challenge = url.searchParams.get("code_challenge") || "";
  const challengeMethod = url.searchParams.get("code_challenge_method");
  const endpoints = endpointSet(request);
  const requestedResource = url.searchParams.get("resource");
  if (clientId.length > 200 || String(url.searchParams.get("state") || "").length > 2000
    || String(requestedResource || "").length > 2048) {
    throw connectorError("OAUTH_REQUEST_INVALID", "Authorization request fields are too large", 400);
  }
  if (!clientId || !redirectUri || responseType !== "code") throw connectorError("OAUTH_REQUEST_INVALID", "Invalid authorization request", 400);
  if (challengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    throw connectorError("OAUTH_PKCE_REQUIRED", "PKCE S256 is required", 400);
  }
  if (requestedResource && requestedResource !== endpoints.mcp) {
    throw connectorError("OAUTH_RESOURCE_INVALID", "Requested resource does not match this MCP endpoint", 400);
  }
  const authRequest = await createOauthRequest({
    clientId,
    redirectUri,
    codeChallenge: challenge,
    requestedScopes: parseScopes(url.searchParams.get("scope")),
    state: url.searchParams.get("state"),
    resource: requestedResource || endpoints.mcp,
  });
  return htmlResponse(authorizePage({ requestId: authRequest.id, clientName: authRequest.clientName }));
}

export async function completeAuthorization(request) {
  consumeOauthBudget(request, "pair");
  const body = await readLimited(request, "form");
  try {
    const result = await authorizePairing(body.request_id, body.pairing_code);
    const redirect = new URL(result.redirectUri);
    redirect.searchParams.set("code", result.code);
    if (result.state) redirect.searchParams.set("state", result.state);
    return NextResponse.redirect(redirect, 302);
  } catch (error) {
    if ([400, 429].includes(error.status)) {
      return htmlResponse(authorizePage({ requestId: body.request_id, error: error.message }), error.status);
    }
    throw error;
  }
}

export async function handleTokenRequest(request) {
  consumeOauthBudget(request, "token");
  const body = await readLimited(request, "form");
  let tokens;
  if (body.grant_type === "authorization_code") {
    tokens = await exchangeAuthorizationCode({
      code: body.code,
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      codeVerifier: body.code_verifier,
    });
  } else if (body.grant_type === "refresh_token") {
    tokens = await rotateRefreshToken({ refreshToken: body.refresh_token, clientId: body.client_id });
  } else {
    throw connectorError("OAUTH_UNSUPPORTED_GRANT", "Unsupported grant type", 400);
  }
  return {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken || undefined,
    scope: tokens.scopes.join(" "),
  };
}

export async function handleRevocationRequest(request) {
  consumeOauthBudget(request, "revoke");
  const body = await readLimited(request, "form");
  if (body.token) await revokeOauthToken(body.token);
  return {};
}

export function oauthJson(data, status = 200, extraHeaders = {}) {
  return NextResponse.json(data, { status, headers: { ...NO_STORE, ...extraHeaders } });
}

export function oauthErrorResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const headers = { ...NO_STORE };
  if (status === 429) headers["Retry-After"] = String(error.retryAfter || 60);
  const oauthCode = {
    OAUTH_INVALID_GRANT: "invalid_grant",
    OAUTH_INVALID_CLIENT: "invalid_client",
    OAUTH_INVALID_SCOPE: "invalid_scope",
    OAUTH_UNSUPPORTED_GRANT: "unsupported_grant_type",
    OAUTH_CLIENT_AUTH_UNSUPPORTED: "invalid_client_metadata",
    OAUTH_REDIRECT_INVALID: "invalid_redirect_uri",
    OAUTH_RATE_LIMIT: "slow_down",
    OAUTH_BODY_TOO_LARGE: "invalid_request",
    OAUTH_INVALID_JSON: "invalid_request",
    OAUTH_REQUEST_INVALID: "invalid_request",
    OAUTH_PKCE_REQUIRED: "invalid_request",
    OAUTH_RESOURCE_INVALID: "invalid_target",
  }[error?.code] || (status >= 500 ? "server_error" : "invalid_request");
  return NextResponse.json({
    error: oauthCode,
    error_description: status >= 500 ? "OAuth operation failed" : error.message,
  }, { status, headers });
}

export const __test__ = { originFor, endpointSet, parseScopes, escapeHtml, authorizePage, readLimited };
