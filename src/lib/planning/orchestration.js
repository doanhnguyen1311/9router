import { createHash } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getPlan, createPlan } from "./service.js";
import { PLAN_LIMITS, planningError } from "./constants.js";
import { extractClientApiKey } from "@/shared/utils/requestApiKey.js";

const NO_STORE_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
});

const FALLBACK_CODES = new Set([
  "PLANNING_OUTPUT_INVALID",
  "PLANNING_RATE_LIMITED",
  "PLANNING_TIMEOUT",
  "PLANNING_UPSTREAM_ERROR",
]);

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.slice(0, PLAN_LIMITS.originalRequestChars + 1).replace(/\u0000/g, "").trim();
}

function contentText(content) {
  if (typeof content === "string") return cleanText(content);
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const item of content) {
    let part = "";
    if (typeof item === "string") part = item;
    else if (item && typeof item === "object") {
      if (["text", "input_text", "output_text"].includes(item.type) && typeof item.text === "string") part = item.text;
      else if (typeof item.text === "string" && !["tool_result", "function_call_output"].includes(item.type)) part = item.text;
    }
    if (!part) continue;
    const separator = text ? "\n" : "";
    const remaining = PLAN_LIMITS.originalRequestChars + 1 - text.length - separator.length;
    text += `${separator}${part.slice(0, Math.max(0, remaining))}`;
    if (text.length > PLAN_LIMITS.originalRequestChars) break;
  }
  return cleanText(text);
}

function latestRoleText(items, contentField = "content") {
  if (!Array.isArray(items)) return { hasUserInput: false, text: "" };
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || typeof item !== "object") continue;
    const role = String(item.role || "").toLowerCase();
    if (["system", "developer"].includes(role)) continue;
    if (["user", "human"].includes(role)) return { hasUserInput: true, text: contentText(item[contentField]) };
    if (["assistant", "model", "tool", "function"].includes(role)
        || ["function_call", "function_call_output", "tool_call", "tool_result"].includes(item.type)) {
      return { hasUserInput: false, text: "" };
    }
  }
  return { hasUserInput: false, text: "" };
}

export function extractPlanningRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { hasUserInput: false, text: "" };

  const messages = latestRoleText(body.messages);
  if (messages.hasUserInput) return messages;

  if (typeof body.input === "string") return { hasUserInput: true, text: cleanText(body.input) };
  const input = latestRoleText(body.input);
  if (input.hasUserInput) return input;

  if (Array.isArray(body.contents)) {
    for (let index = body.contents.length - 1; index >= 0; index -= 1) {
      const item = body.contents[index];
      if (!item || typeof item !== "object") continue;
      const role = String(item.role || "user").toLowerCase();
      if (["model", "assistant", "tool", "function"].includes(role)) return { hasUserInput: false, text: "" };
      if (!["user", "human"].includes(role)) continue;
      const parts = Array.isArray(item.parts) ? contentText(item.parts) : "";
      return { hasUserInput: true, text: parts };
    }
  }

  if (typeof body.prompt === "string") return { hasUserInput: true, text: cleanText(body.prompt) };
  return { hasUserInput: false, text: "" };
}

function hashBoundValue(apiKeyId, purpose, value) {
  if (!value) return null;
  return createHash("sha256").update(`${apiKeyId}\u0000${purpose}\u0000${value}`).digest("hex");
}

function idempotencyValue(request) {
  const value = request.headers.get("idempotency-key")
    || request.headers.get("x-idempotency-key")
    || request.headers.get("x-request-id");
  if (!value) return null;
  const clean = value.trim();
  if (!clean || clean.length > 200 || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw planningError("PLANNING_IDEMPOTENCY_INVALID", "Planning idempotency key is invalid", 400);
  }
  return clean;
}

function planningIdentity(keyRecord) {
  return {
    principalId: keyRecord.ownerId,
    displayName: keyRecord.name || "API key owner",
    authenticated: true,
    admin: false,
    apiKeyId: keyRecord.id,
  };
}

export function shouldCreateAutomaticPlan(request, body, keyRecord) {
  const planning = keyRecord?.planning;
  if (!keyRecord?.isActive || keyRecord?.isExpired || !planning?.planningEnabled) {
    return { create: false, reason: "disabled" };
  }
  if (planning.planningMode === "OFF") return { create: false, reason: "disabled" };
  const extracted = extractPlanningRequest(body);
  const explicit = String(request.headers.get("x-9router-planning") || "").trim().toLowerCase() === "plan";
  const create = planning.planningMode === "ADAPTIVE" ? extracted.hasUserInput : explicit;
  if (!create) return { create: false, reason: extracted.hasUserInput ? "manual-signal-required" : "not-user-input" };
  if (!extracted.text) {
    throw planningError("PLANNING_REQUEST_TEXT_REQUIRED", "Planning requires a textual user request", 400);
  }
  return { create: true, originalRequest: extracted.text };
}

function actionNames(status, selectedOptionId) {
  if (status === "DRAFT") return ["poll"];
  if (status === "NEEDS_CLARIFICATION") return ["revise", "cancel"];
  if (status === "OPTIONS_READY") return selectedOptionId
    ? ["select_option", "revise", "request_approval", "cancel"]
    : ["select_option", "revise", "cancel"];
  if (status === "PENDING_APPROVAL") return ["approve", "reject", "revise", "cancel"];
  if (status === "APPROVED") return ["execute"];
  if (status === "EXECUTING") return ["poll", "cancel_execution"];
  return [];
}

export function serializePlanningSession(plan, keyRecord) {
  const self = `/api/v1/planning/sessions/${encodeURIComponent(plan.id)}`;
  const recommended = plan.options?.find((option) => option.recommended)?.id || null;
  return {
    object: "9router.planning_session",
    planId: plan.id,
    projectId: plan.projectId,
    apiKeyId: plan.apiKeyId,
    status: plan.status,
    version: plan.version,
    revision: plan.currentRevision,
    originalRequest: plan.originalRequest,
    interpretedObjective: plan.interpretedObjective,
    assumptions: plan.assumptions || [],
    missingInformation: plan.missingInformation || [],
    constraints: plan.constraints || [],
    affectedModules: plan.affectedModules || [],
    risks: plan.risks || [],
    options: plan.options || [],
    selectedOptionId: plan.selectedOptionId || null,
    recommendedOptionId: recommended,
    approvalRequired: keyRecord?.planning?.approvalRequired !== false,
    availableActions: actionNames(plan.status, plan.selectedOptionId),
    provider: { id: plan.providerId, model: plan.modelId },
    expiresAt: plan.expiresAt,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    links: {
      self,
      dashboard: `/dashboard/projects/${encodeURIComponent(plan.projectId)}`,
    },
  };
}

export function planningSessionResponse(plan, keyRecord, status = 202) {
  const session = serializePlanningSession(plan, keyRecord);
  return new Response(JSON.stringify(session), {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      Location: session.links.self,
      "X-9Router-Plan-Id": plan.id,
      "X-9Router-Planning-Status": plan.status,
      "Access-Control-Expose-Headers": "Location, X-9Router-Plan-Id, X-9Router-Planning-Status",
    },
  });
}

export function planningOperationErrorResponse(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const message = status >= 500 ? "Planning operation failed" : String(error?.message || "Planning request failed");
  return new Response(JSON.stringify({
    error: { type: "planning_error", code: error?.code || "PLANNING_ERROR", message },
  }), { status, headers: NO_STORE_HEADERS });
}

export async function orchestratePlanningRequest({ request, body, keyRecord, sessionId = null, endpoint = null, provider } = {}) {
  let decision;
  try {
    decision = shouldCreateAutomaticPlan(request, body, keyRecord);
  } catch (error) {
    return { handled: true, response: planningOperationErrorResponse(error), error };
  }
  if (!decision.create) return { handled: false, reason: decision.reason };

  try {
    if (!keyRecord.projectAccess || !keyRecord.assignedProjectId) {
      throw planningError("PLANNING_PROJECT_REQUIRED", "Planning requires an assigned Project", 409);
    }
    const idempotency = idempotencyValue(request);
    const sourceEndpoint = String(endpoint || new URL(request.url).pathname).slice(0, 300);
    const requestKeyHash = hashBoundValue(keyRecord.id, "planning-request", idempotency);
    const requestBinding = requestKeyHash ? {
      requestKeyHash,
      clientSessionHash: hashBoundValue(keyRecord.id, "client-session", sessionId),
      sourceEndpoint,
    } : null;
    const plan = await createPlan(keyRecord.assignedProjectId, {
      originalRequest: decision.originalRequest,
      providerId: keyRecord.planning.planningProviderId,
      modelId: keyRecord.planning.planningModelId,
      contextTokenBudget: keyRecord.planning.contextTokenBudget,
      expirationMinutes: keyRecord.planning.planExpiration,
    }, planningIdentity(keyRecord), {
      provider,
      signal: request.signal,
      apiKeyId: keyRecord.id,
      requestBinding,
    });
    return { handled: true, response: planningSessionResponse(plan, keyRecord), plan };
  } catch (error) {
    if (keyRecord.planning.failurePolicy === "LEGACY_PATH" && FALLBACK_CODES.has(error?.code)) {
      return { handled: false, reason: "provider-fallback", fallbackError: error };
    }
    return { handled: true, response: planningOperationErrorResponse(error), error };
  }
}

export async function getPlanningSessionForApiKey(request, planId) {
  const apiKey = extractClientApiKey(request);
  if (!apiKey) throw planningError("UNAUTHORIZED", "A valid API key is required", 401);
  const keyRecord = await getApiKeyByKey(apiKey);
  if (!keyRecord?.isActive || keyRecord.isExpired) {
    throw planningError("UNAUTHORIZED", "A valid API key is required", 401);
  }
  if (!keyRecord.planning?.planningEnabled) {
    throw planningError("PLANNING_DISABLED", "Planning is disabled for this API key", 403);
  }
  if (!keyRecord.projectAccess || !keyRecord.assignedProjectId) {
    throw planningError("PLANNING_PROJECT_REQUIRED", "Planning requires an assigned Project", 409);
  }
  const db = await getAdapter();
  const owned = db.get(
    "SELECT id FROM executionPlans WHERE id=? AND projectId=? AND apiKeyId=?",
    [planId, keyRecord.assignedProjectId, keyRecord.id],
  );
  if (!owned) throw planningError("PLAN_NOT_FOUND", "Plan not found", 404);
  const plan = await getPlan(keyRecord.assignedProjectId, planId, planningIdentity(keyRecord));
  return { plan, keyRecord, identity: planningIdentity(keyRecord) };
}

export const __test__ = { contentText, hashBoundValue, idempotencyValue, latestRoleText };
