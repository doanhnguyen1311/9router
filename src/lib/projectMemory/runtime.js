import { normalizeRequestContent, normalizeResponseContent, latestQueryText } from "./normalizer.js";
import { enqueueMemoryEvent } from "./queue.js";
import {
  recordSessionRoute,
  resolveGatewayProjectForKeyRecord,
  resolvePersistentSession,
} from "./repository.js";
import {
  injectProjectContext,
  recordMemoryUsage,
  retrieveProjectContext,
  saveContextSnapshot,
} from "./retrieval.js";

const runtimeByRequest = new WeakMap();

function clientNamespace(request, endpoint = "") {
  const userAgent = String(request?.headers?.get?.("user-agent") || "").toLowerCase();
  if (userAgent.includes("claude")) return "claude-code";
  if (userAgent.includes("codex")) return "codex";
  if (userAgent.includes("cursor")) return "cursor";
  if (userAgent.includes("cline")) return "cline";
  if (userAgent.includes("trae")) return "trae";
  if (endpoint.includes("/messages")) return "anthropic-compatible";
  if (endpoint.includes("/responses")) return "openai-responses";
  if (endpoint.includes("v1beta")) return "gemini-compatible";
  return "openai-compatible";
}

export async function prepareProjectRequest({ request, body, keyRecord, clientSessionId, endpoint }) {
  // This guard executes before any Project Memory DB work. Ordinary keys keep
  // the historical route without retrieval, extraction or an extra model call.
  if (!keyRecord?.assignedProjectId || !keyRecord.projectAccess) return { body, runtime: null };
  const resolved = await resolveGatewayProjectForKeyRecord(keyRecord);
  if (!resolved) return { body, runtime: null };
  const namespace = clientNamespace(request, endpoint);
  const session = await resolvePersistentSession({
    projectId: resolved.project.id,
    apiKeyId: resolved.apiKeyId,
    clientNamespace: namespace,
    clientSessionId: clientSessionId || `${namespace}:ephemeral`,
  });
  const runtime = { ...resolved, session, namespace, originalBody: body, context: null };
  runtimeByRequest.set(request, runtime);

  const normalized = normalizeRequestContent(body);
  if (resolved.settings.extractionEnabled) {
    if (normalized.userText) {
      void enqueueMemoryEvent({
        projectId: resolved.project.id,
        sessionId: session.id,
        eventType: "request-user",
        sourceType: "user-confirmed",
        payload: { text: normalized.userText },
        evidenceReference: `session:${session.id}:request`,
      }).catch((error) => console.warn("[Project Memory] request event:", error.message));
    }
    if (normalized.toolText) {
      void enqueueMemoryEvent({
        projectId: resolved.project.id,
        sessionId: session.id,
        eventType: "tool-result",
        sourceType: "tool-verified",
        payload: { text: normalized.toolText },
        evidenceReference: `session:${session.id}:tool`,
      }).catch((error) => console.warn("[Project Memory] tool event:", error.message));
    }
  }

  if (!resolved.settings.retrievalEnabled) return { body, runtime };
  const query = latestQueryText(body);
  if (!query) return { body, runtime };
  const context = await retrieveProjectContext({
    projectId: resolved.project.id,
    query,
    tokenBudget: resolved.settings.contextTokenBudget,
    maxGraphDepth: resolved.settings.maxGraphDepth,
  });
  runtime.context = context;
  await recordMemoryUsage({
    projectId: resolved.project.id,
    sessionId: session.id,
    operation: "retrieval",
    durationMs: context.durationMs,
    itemCount: context.memories + context.files + (context.symbols || 0) + context.dependencies + context.entities,
    tokenEstimate: context.tokenEstimate,
    status: "ok",
    metadata: { terms: context.terms.length },
  });
  if (!context.hasContext) return { body, runtime };
  await saveContextSnapshot({
    projectId: resolved.project.id,
    sessionId: session.id,
    content: context.content,
    tokenEstimate: context.tokenEstimate,
  });
  return { body: injectProjectContext(body, context.content), runtime };
}

export function getProjectRequestRuntime(request) {
  return request ? runtimeByRequest.get(request) || null : null;
}

export async function recordProjectRouteForRequest(request, provider, accountId) {
  const runtime = getProjectRequestRuntime(request);
  if (!runtime?.session?.id) return;
  await recordSessionRoute(runtime.session.id, provider, accountId);
}

export function observeProjectResponse(request, response) {
  const runtime = getProjectRequestRuntime(request);
  if (!runtime || !runtime.settings.extractionEnabled || !response?.ok) return;
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  // Never clone an unbounded SSE stream: that can retain the full response and
  // create backpressure. Streaming turns still extract user and tool evidence.
  if (!contentType.includes("application/json")) return;
  void (async () => {
    try {
      const text = await response.clone().text();
      if (text.length > 512_000) return;
      const assistantText = normalizeResponseContent(text);
      if (!assistantText) return;
      await enqueueMemoryEvent({
        projectId: runtime.project.id,
        sessionId: runtime.session.id,
        eventType: "assistant-response",
        sourceType: "assistant-suggested",
        payload: { text: assistantText },
        evidenceReference: `session:${runtime.session.id}:response`,
      });
    } catch (error) {
      console.warn("[Project Memory] response observer:", error.message);
    }
  })();
}

export const __test__ = { clientNamespace };
