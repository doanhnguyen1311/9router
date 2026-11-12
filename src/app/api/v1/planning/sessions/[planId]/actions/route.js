import { readPlanningJson } from "@/app/api/v1/projects/[id]/plans/_response.js";
import {
  getPlanningSessionForApiKey,
  planningCorsOptionsResponse,
  planningOperationErrorResponse,
  planningSessionResponse,
} from "@/lib/planning/orchestration.js";
import {
  approvePlan,
  cancelPlan,
  getPlan,
  rejectPlan,
  requestApproval,
  revisePlan,
  selectOption,
  submitFeedback,
} from "@/lib/planning/service.js";
import { planningError } from "@/lib/planning/constants.js";
import { consumeProjectApiBudget } from "@/lib/projectMemory/rateLimit.js";

export const dynamic = "force-dynamic";

const ACTION_FIELDS = Object.freeze({
  select_option: new Set(["action", "expectedVersion", "optionId"]),
  submit_feedback: new Set(["action", "expectedVersion", "feedback"]),
  revise: new Set(["action", "expectedVersion", "feedback", "timeoutMs"]),
  request_approval: new Set(["action", "expectedVersion"]),
  approve: new Set(["action", "expectedVersion", "optionId", "scope", "idempotencyKey", "reason"]),
  reject: new Set(["action", "expectedVersion", "optionId", "scope", "idempotencyKey", "reason"]),
  cancel: new Set(["action", "expectedVersion", "reason"]),
});

function validateAction(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw planningError("PLANNING_ACTION_INVALID", "Planning action body must be an object", 400);
  }
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  const fields = ACTION_FIELDS[action];
  if (!fields) throw planningError("PLANNING_ACTION_INVALID", "Unknown planning action", 400);
  const unexpected = Object.keys(body).find((key) => !fields.has(key));
  if (unexpected) {
    throw planningError("PLANNING_ACTION_INVALID", `Unexpected field for ${action}: ${unexpected}`, 400);
  }
  return action;
}

function enforceActionRateLimit(keyRecord, request) {
  const budget = consumeProjectApiBudget(`planning-key:${keyRecord.id}`, request);
  if (budget.allowed) return;
  throw planningError("PLANNING_RATE_LIMITED", "Planning action rate limit exceeded", 429, {
    retryAfter: budget.retryAfter,
  });
}

async function applyAction(action, projectId, planId, body, identity, signal) {
  if (action === "select_option") return selectOption(projectId, planId, body, identity);
  if (action === "submit_feedback") return submitFeedback(projectId, planId, body, identity);
  if (action === "revise") return revisePlan(projectId, planId, body, identity, { signal });
  if (action === "request_approval") return requestApproval(projectId, planId, body, identity);
  if (action === "approve") return approvePlan(projectId, planId, body, identity);
  if (action === "reject") return rejectPlan(projectId, planId, body, identity);
  if (action === "cancel") return cancelPlan(projectId, planId, body, identity);
  throw planningError("PLANNING_ACTION_INVALID", "Unknown planning action", 400);
}

export function OPTIONS() {
  return planningCorsOptionsResponse();
}

export async function POST(request, { params }) {
  try {
    const { planId } = await params;
    const { plan, keyRecord, identity } = await getPlanningSessionForApiKey(request, planId);
    enforceActionRateLimit(keyRecord, request);
    const body = await readPlanningJson(request);
    const action = validateAction(body);
    await applyAction(action, plan.projectId, plan.id, body, identity, request.signal);
    const updated = await getPlan(plan.projectId, plan.id, identity);
    return planningSessionResponse(updated, keyRecord, 200);
  } catch (error) {
    return planningOperationErrorResponse(error);
  }
}

export const __test__ = { ACTION_FIELDS, applyAction, validateAction };
