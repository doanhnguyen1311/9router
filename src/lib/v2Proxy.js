import { admitApiKeyRequest, getV2ProxyConfigByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { extractClientApiKey } from "@/shared/utils/requestApiKey.js";
import { fetchPublic } from "@/shared/utils/ssrfGuard.js";

export const V2_ERROR_CODES = Object.freeze({
  INVALID_API_KEY: 1001,
  V2_NOT_ALLOWED: 1002,
  QUOTA_EXCEEDED: 1003,
  INVALID_REQUEST: 1004,
  UPSTREAM_TIMEOUT: 2001,
  UPSTREAM_FAILURE: 2002,
  INTERNAL_FAILURE: 9000,
});

const CONNECT_TIMEOUT_MS = 60_000;
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "openai-beta",
  "anthropic-beta",
  "anthropic-version",
]);

function numericError(code, status) {
  return new Response(String(code), {
    status,
    statusText: "",
    headers: {
      "content-type": "text/plain",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

export function v2PreflightResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
      "access-control-allow-headers": "*",
      "access-control-max-age": "86400",
    },
  });
}

function normalizedPathSegments(pathSegments) {
  if (!Array.isArray(pathSegments)) return [];
  if (pathSegments.length > 32) throw new Error("invalid path");
  return pathSegments.map((segment) => {
    if (typeof segment !== "string" || !segment || segment === "." || segment === ".."
      || segment.includes("/") || segment.includes("\\") || segment.length > 256) {
      throw new Error("invalid path");
    }
    return encodeURIComponent(segment);
  });
}

export function buildV2UpstreamUrl(baseUrl, pathSegments, requestUrl) {
  const target = new URL(baseUrl);
  const suffix = normalizedPathSegments(pathSegments);
  const basePath = target.pathname.replace(/\/+$/, "");
  target.pathname = `${basePath}/${suffix.join("/")}`.replace(/\/$/, "") || "/";

  const incoming = new URL(requestUrl);
  incoming.searchParams.delete("key");
  target.search = incoming.searchParams.toString();
  return target.toString();
}

function upstreamRequestHeaders(request, upstreamApiKey) {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }

  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    headers.set("authorization", `Bearer ${upstreamApiKey}`);
  } else if (request.headers.get("x-api-key")) {
    headers.set("x-api-key", upstreamApiKey);
  } else if (request.headers.get("x-goog-api-key") || new URL(request.url).searchParams.has("key")) {
    headers.set("x-goog-api-key", upstreamApiKey);
  } else {
    headers.set("authorization", `Bearer ${upstreamApiKey}`);
  }
  return headers;
}

function hasErrorEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "error")) return true;
  return typeof value.type === "string" && value.type.toLowerCase() === "error";
}

function containsSensitiveText(text, sensitiveValues) {
  return sensitiveValues.some((value) => value && text.includes(value));
}

function isSseErrorEvent(event, sensitiveValues) {
  if (containsSensitiveText(event, sensitiveValues)) return true;
  let eventType = "";
  const data = [];
  for (const line of event.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim().toLowerCase();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (eventType === "error") return true;
  if (!data.length) return false;
  try {
    return hasErrorEnvelope(JSON.parse(data.join("\n")));
  } catch {
    return false;
  }
}

function splitSseEvent(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { event: buffer.slice(0, crlf), rest: buffer.slice(crlf + 4), delimiter: "\r\n\r\n" };
  }
  return { event: buffer.slice(0, lf), rest: buffer.slice(lf + 2), delimiter: "\n\n" };
}

export function sanitizeV2SseStream(body, sensitiveValues = []) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let part;
      while ((part = splitSseEvent(buffer))) {
        buffer = part.rest;
        controller.enqueue(encoder.encode(
          isSseErrorEvent(part.event, sensitiveValues)
            ? `${V2_ERROR_CODES.UPSTREAM_FAILURE}${part.delimiter}`
            : `${part.event}${part.delimiter}`,
        ));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (!buffer) return;
      controller.enqueue(encoder.encode(
        isSseErrorEvent(buffer, sensitiveValues) ? `${V2_ERROR_CODES.UPSTREAM_FAILURE}\n\n` : buffer,
      ));
    },
  }));
}

function safeContentType(rawContentType) {
  const contentType = String(rawContentType || "").trim().toLowerCase();
  const mime = contentType.split(";", 1)[0].trim();
  if (mime === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(mime)) return "application/json";
  if (mime === "text/event-stream") return "text/event-stream";
  if (/^(audio|image)\/[a-z0-9.+-]+$/.test(mime)) return mime;
  if (mime === "application/octet-stream") return mime;
  return null;
}

function successHeaders(contentType) {
  const headers = new Headers({
    "content-type": contentType,
    "access-control-allow-origin": "*",
  });
  if (contentType === "text/event-stream") headers.set("cache-control", "no-cache");
  return headers;
}

function wrapBodyCancellation(body, abortController, cleanup, streamFailureChunk = null) {
  if (!body) {
    cleanup();
    return null;
  }
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch {
        cleanup();
        if (streamFailureChunk) controller.enqueue(streamFailureChunk);
        controller.close();
      }
    },
    cancel(reason) {
      cleanup();
      abortController.abort();
      return reader.cancel(reason);
    },
  });
}

export async function handleV2ProxyRequest(request, pathSegments = [], dependencies = {}) {
  const lookupConfig = dependencies.getV2ProxyConfigByKey || getV2ProxyConfigByKey;
  const admitRequest = dependencies.admitApiKeyRequest || admitApiKeyRequest;
  const fetchUpstream = dependencies.fetchUpstream || fetchPublic;

  if (request.method === "OPTIONS") return v2PreflightResponse();

  const facadeApiKey = extractClientApiKey(request);
  if (!facadeApiKey) return numericError(V2_ERROR_CODES.INVALID_API_KEY, 401);

  let lookup;
  try {
    lookup = await lookupConfig(facadeApiKey);
  } catch {
    return numericError(V2_ERROR_CODES.INTERNAL_FAILURE, 500);
  }
  if (!lookup?.record || !lookup.record.isActive || lookup.record.isExpired) {
    return numericError(V2_ERROR_CODES.INVALID_API_KEY, 401);
  }
  if (!lookup.record.v2Proxy?.enabled) {
    return numericError(V2_ERROR_CODES.V2_NOT_ALLOWED, 403);
  }
  if (lookup.invalid || !lookup.config) {
    return numericError(V2_ERROR_CODES.INTERNAL_FAILURE, 500);
  }

  let admission;
  try {
    admission = await admitRequest(facadeApiKey);
  } catch {
    return numericError(V2_ERROR_CODES.INTERNAL_FAILURE, 500);
  }
  if (!admission?.tracked) return numericError(V2_ERROR_CODES.INVALID_API_KEY, 401);
  if (!admission.allowed) {
    const isKeyState = admission.reason === "expired" || admission.reason === "inactive";
    return numericError(
      isKeyState ? V2_ERROR_CODES.INVALID_API_KEY : V2_ERROR_CODES.QUOTA_EXCEEDED,
      isKeyState ? 401 : 429,
    );
  }

  let targetUrl;
  let headers;
  try {
    targetUrl = buildV2UpstreamUrl(lookup.config.upstreamBaseUrl, pathSegments, request.url);
    headers = upstreamRequestHeaders(request, lookup.config.upstreamApiKey);
  } catch {
    return numericError(V2_ERROR_CODES.INVALID_REQUEST, 400);
  }

  const abortController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, CONNECT_TIMEOUT_MS);
  const onClientAbort = () => abortController.abort();
  if (request.signal?.aborted) onClientAbort();
  else request.signal?.addEventListener("abort", onClientAbort, { once: true });
  const cleanup = () => {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", onClientAbort);
  };

  let upstreamResponse;
  try {
    const hasBody = !["GET", "HEAD"].includes(request.method);
    upstreamResponse = await fetchUpstream(targetUrl, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      duplex: hasBody ? "half" : undefined,
      signal: abortController.signal,
    }, { maxRedirects: 0 });
    clearTimeout(timeout);
  } catch {
    cleanup();
    return numericError(
      timedOut ? V2_ERROR_CODES.UPSTREAM_TIMEOUT : V2_ERROR_CODES.UPSTREAM_FAILURE,
      timedOut ? 504 : 502,
    );
  }

  if (!upstreamResponse.ok) {
    cleanup();
    try { await upstreamResponse.body?.cancel(); } catch { /* ignore */ }
    return numericError(V2_ERROR_CODES.UPSTREAM_FAILURE, 502);
  }

  if (request.method === "HEAD" || upstreamResponse.status === 204 || upstreamResponse.status === 205) {
    cleanup();
    return new Response(null, {
      status: upstreamResponse.status,
      headers: { "access-control-allow-origin": "*" },
    });
  }

  const contentType = safeContentType(upstreamResponse.headers.get("content-type"));
  if (!contentType) {
    cleanup();
    try { await upstreamResponse.body?.cancel(); } catch { /* ignore */ }
    return numericError(V2_ERROR_CODES.UPSTREAM_FAILURE, 502);
  }

  if (contentType === "application/json") {
    try {
      const bodyText = await upstreamResponse.text();
      cleanup();
      const sensitiveValues = [lookup.config.upstreamBaseUrl, lookup.config.upstreamApiKey];
      try {
        const upstream = new URL(lookup.config.upstreamBaseUrl);
        sensitiveValues.push(upstream.origin, upstream.host, upstream.hostname);
      } catch { /* validated before storage */ }
      if (containsSensitiveText(bodyText, sensitiveValues)) {
        return numericError(V2_ERROR_CODES.UPSTREAM_FAILURE, 502);
      }
      const parsed = JSON.parse(bodyText);
      if (hasErrorEnvelope(parsed)) return numericError(V2_ERROR_CODES.UPSTREAM_FAILURE, 502);
      return new Response(bodyText, {
        status: upstreamResponse.status,
        headers: successHeaders(contentType),
      });
    } catch {
      cleanup();
      return numericError(V2_ERROR_CODES.UPSTREAM_FAILURE, 502);
    }
  }

  const sensitiveValues = [lookup.config.upstreamBaseUrl, lookup.config.upstreamApiKey];
  try {
    const upstream = new URL(lookup.config.upstreamBaseUrl);
    sensitiveValues.push(upstream.origin, upstream.host, upstream.hostname);
  } catch { /* validated before storage */ }
  const responseBody = contentType === "text/event-stream"
    ? sanitizeV2SseStream(upstreamResponse.body, sensitiveValues)
    : upstreamResponse.body;
  const streamFailureChunk = contentType === "text/event-stream"
    ? new TextEncoder().encode(`${V2_ERROR_CODES.UPSTREAM_FAILURE}\n\n`)
    : null;
  return new Response(wrapBodyCancellation(responseBody, abortController, cleanup, streamFailureChunk), {
    status: upstreamResponse.status,
    headers: successHeaders(contentType),
  });
}
