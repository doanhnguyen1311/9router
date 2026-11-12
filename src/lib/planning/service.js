import { getAdapter } from "@/lib/db/driver.js";
import { redactProjectText } from "@/lib/projectMemory/privacy.js";
import { requireProjectRole } from "@/lib/projectMemory/repository.js";
import { buildPlanningContext } from "./context.js";
import {
  PLAN_LIMITS,
  PLAN_STATUSES,
  boundedInteger,
  planningError,
} from "./constants.js";
import { getPlanningProvider } from "./routerProvider.js";
import {
  cancelPlan as cancelPlanRecord,
  commitPlanRevision,
  createDraftPlan,
  getPlan as getPlanRecord,
  listPlanOptions,
  listPlanRevisions,
  listPlans as listPlanRecords,
  recordPlanningFailure,
  requestPlanApproval as requestPlanApprovalRecord,
  selectPlanOption as selectPlanOptionRecord,
  submitPlanFeedback as submitPlanFeedbackRecord,
} from "./repository.js";

function cleanRequiredText(value, name, maxChars) {
  if (typeof value !== "string" || !value.trim()) throw planningError("PLANNING_INPUT_INVALID", `${name} is required`, 400);
  const clean = value.replace(/\u0000/g, "").trim();
  if (clean.length > maxChars) throw planningError("PLANNING_INPUT_INVALID", `${name} exceeds ${maxChars} characters`, 400);
  return redactProjectText(clean).text;
}

function expectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw planningError("PLAN_VERSION_REQUIRED", "A positive expectedVersion is required", 400);
  return value;
}

function loadPlanningContextSnapshot(plan) {
  if (!plan.contextSnapshotId) return { content: "", provenance: {} };
  return getAdapter().then((db) => {
    const row = db.get(
      "SELECT content, contentHash, tokenEstimate FROM contextSnapshots WHERE id=? AND projectId=? AND snapshotType='planning'",
      [plan.contextSnapshotId, plan.projectId],
    );
    if (!row) throw planningError("PLAN_CONTEXT_MISSING", "Planning context snapshot is unavailable", 409);
    let parsed;
    try { parsed = JSON.parse(row.content); }
    catch { throw planningError("PLAN_CONTEXT_INVALID", "Planning context snapshot is invalid", 500); }
    return {
      content: typeof parsed.content === "string" ? parsed.content : "",
      provenance: parsed.provenance && typeof parsed.provenance === "object" ? parsed.provenance : {},
      contentHash: row.contentHash,
      tokenEstimate: row.tokenEstimate,
    };
  });
}

export async function createPlan(projectId, input, identity, { provider = getPlanningProvider(), signal = null } = {}) {
  const originalRequest = cleanRequiredText(input?.originalRequest, "originalRequest", PLAN_LIMITS.originalRequestChars);
  const providerId = cleanRequiredText(input?.providerId, "providerId", PLAN_LIMITS.providerIdChars);
  const modelId = cleanRequiredText(input?.modelId, "modelId", PLAN_LIMITS.modelIdChars);
  const timeoutMs = boundedInteger(
    input?.timeoutMs,
    PLAN_LIMITS.timeoutMsMin,
    PLAN_LIMITS.timeoutMsMax,
    PLAN_LIMITS.defaultTimeoutMs,
  );
  const expirationMinutes = boundedInteger(
    input?.expirationMinutes,
    PLAN_LIMITS.expirationMinutesMin,
    PLAN_LIMITS.expirationMinutesMax,
    PLAN_LIMITS.defaultExpirationMinutes,
  );
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  await provider.validateCapabilities({ providerId, modelId });
  const context = await buildPlanningContext({ projectId, query: originalRequest, tokenBudget: input?.contextTokenBudget });
  const expiresAt = new Date(Date.now() + expirationMinutes * 60_000).toISOString();
  const draft = await createDraftPlan({ projectId, originalRequest, providerId, modelId, context, expiresAt }, identity);
  try {
    const generated = await provider.generatePlan({
      providerId,
      modelId,
      originalRequest,
      context,
      timeoutMs,
      signal,
    });
    return await commitPlanRevision({
      projectId,
      planId: draft.id,
      expectedVersion: draft.version,
      output: generated.plan,
      usage: { ...generated.usage, attempts: generated.attempts },
    }, identity);
  } catch (error) {
    try {
      await recordPlanningFailure({
        projectId,
        planId: draft.id,
        expectedVersion: draft.version,
        error,
        operation: "generation",
      }, identity);
    } catch { /* preserve the provider error; audit conflict is independently observable */ }
    throw error;
  }
}

export async function revisePlan(projectId, planId, input, identity, { provider = getPlanningProvider(), signal = null } = {}) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const version = expectedVersion(input?.expectedVersion);
  const feedback = cleanRequiredText(input?.feedback, "feedback", PLAN_LIMITS.feedbackChars);
  const current = await getPlanRecord(projectId, planId, identity);
  if (current.version !== version) throw planningError("PLAN_VERSION_CONFLICT", "Plan version is stale", 409, { currentVersion: current.version });
  if (!["NEEDS_CLARIFICATION", "OPTIONS_READY", "PENDING_APPROVAL"].includes(current.status)) {
    throw planningError("PLAN_STATE_CONFLICT", `Plan cannot be revised from ${current.status}`, 409);
  }
  const previousRevision = current.revisions.find((revision) => revision.revision === current.currentRevision);
  if (!previousRevision) throw planningError("PLAN_REVISION_MISSING", "Current plan revision is unavailable", 409);
  const context = await loadPlanningContextSnapshot(current);
  try {
    const generated = await provider.revisePlan({
      providerId: current.providerId,
      modelId: current.modelId,
      originalRequest: current.originalRequest,
      previousPlan: previousRevision.content,
      feedback,
      context,
      timeoutMs: boundedInteger(
        input?.timeoutMs,
        PLAN_LIMITS.timeoutMsMin,
        PLAN_LIMITS.timeoutMsMax,
        PLAN_LIMITS.defaultTimeoutMs,
      ),
      signal,
    });
    return await commitPlanRevision({
      projectId,
      planId,
      expectedVersion: version,
      output: generated.plan,
      usage: { ...generated.usage, attempts: generated.attempts },
      feedback,
      sourceRevision: current.currentRevision,
    }, identity);
  } catch (error) {
    try {
      await recordPlanningFailure({ projectId, planId, expectedVersion: version, error, operation: "revision" }, identity);
    } catch { /* keep the original provider/concurrency failure */ }
    throw error;
  }
}

export function listPlans(projectId, identity, query = {}) {
  const status = query.status == null ? null : String(query.status).toUpperCase();
  if (status && !PLAN_STATUSES.includes(status)) throw planningError("PLANNING_INPUT_INVALID", "Unknown plan status", 400);
  return listPlanRecords(projectId, identity, { status, limit: query.limit });
}

export function getPlan(projectId, planId, identity) {
  return getPlanRecord(projectId, planId, identity);
}

export function getPlanOptions(projectId, planId, identity, revision = null) {
  return listPlanOptions(projectId, planId, identity, revision);
}

export function getPlanRevisions(projectId, planId, identity) {
  return listPlanRevisions(projectId, planId, identity);
}

export function submitFeedback(projectId, planId, input, identity) {
  return submitPlanFeedbackRecord({
    projectId,
    planId,
    expectedVersion: expectedVersion(input?.expectedVersion),
    feedback: cleanRequiredText(input?.feedback, "feedback", PLAN_LIMITS.feedbackChars),
  }, identity);
}

export function selectOption(projectId, planId, input, identity) {
  return selectPlanOptionRecord({
    projectId,
    planId,
    optionId: cleanRequiredText(input?.optionId, "optionId", 200),
    expectedVersion: expectedVersion(input?.expectedVersion),
  }, identity);
}

export function requestApproval(projectId, planId, input, identity) {
  return requestPlanApprovalRecord({
    projectId,
    planId,
    expectedVersion: expectedVersion(input?.expectedVersion),
  }, identity);
}

export function cancelPlan(projectId, planId, input, identity) {
  const reason = input?.reason == null || input.reason === ""
    ? ""
    : cleanRequiredText(input.reason, "reason", 2000);
  return cancelPlanRecord({
    projectId,
    planId,
    expectedVersion: expectedVersion(input?.expectedVersion),
    reason,
  }, identity);
}

export async function planningProviderHealth(input, { provider = getPlanningProvider() } = {}) {
  return provider.healthCheck({ providerId: input?.providerId, modelId: input?.modelId });
}

export const __test__ = { cleanRequiredText, expectedVersion, loadPlanningContextSnapshot };
