export const KEY_PLANNING_MODES = Object.freeze(["OFF", "MANUAL", "ADAPTIVE"]);
export const KEY_PLANNING_FAILURE_POLICIES = Object.freeze(["LEGACY_PATH", "FAIL_CLOSED"]);

export const KEY_PLANNING_DEFAULT = Object.freeze({
  planningEnabled: false,
  planningMode: "OFF",
  planningProviderId: null,
  planningModelId: null,
  approvalRequired: true,
  contextTokenBudget: 1800,
  planExpiration: 10080,
  failurePolicy: "FAIL_CLOSED",
});

const cleanOptionalId = (value, field, maxLength) => {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, error: `${field} must be a non-empty string no longer than ${maxLength} characters` };
  }
  return { ok: true, value: value.trim() };
};

export function keyPlanningFromColumns(row = {}) {
  const rawEnabled = row.planningEnabled === 1 || row.planningEnabled === true;
  const rawMode = String(row.planningMode || "OFF").toUpperCase();
  const planningProviderId = typeof row.planningProviderId === "string" && row.planningProviderId.trim()
    ? row.planningProviderId.trim().slice(0, 120)
    : null;
  const planningModelId = typeof row.planningModelId === "string" && row.planningModelId.trim()
    ? row.planningModelId.trim().slice(0, 240)
    : null;
  const planningEnabled = rawEnabled
    && ["MANUAL", "ADAPTIVE"].includes(rawMode)
    && Boolean(planningProviderId && planningModelId);
  const planningMode = planningEnabled ? rawMode : "OFF";
  const rawFailure = String(row.planningFailurePolicy || "FAIL_CLOSED").toUpperCase();
  const rawBudget = Number(row.planningContextTokenBudget);
  const rawExpiration = Number(row.planningPlanExpirationMinutes);
  return {
    planningEnabled,
    planningMode,
    planningProviderId,
    planningModelId,
    approvalRequired: row.planningApprovalRequired !== 0 && row.planningApprovalRequired !== false,
    contextTokenBudget: Number.isSafeInteger(rawBudget) && rawBudget >= 256 && rawBudget <= 16000
      ? rawBudget
      : KEY_PLANNING_DEFAULT.contextTokenBudget,
    planExpiration: Number.isSafeInteger(rawExpiration) && rawExpiration >= 5 && rawExpiration <= 43200
      ? rawExpiration
      : KEY_PLANNING_DEFAULT.planExpiration,
    failurePolicy: KEY_PLANNING_FAILURE_POLICIES.includes(rawFailure) ? rawFailure : "FAIL_CLOSED",
  };
}

export function validateKeyPlanningInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "planning must be an object" };
  }
  const allowed = new Set([
    "planningEnabled", "planningMode", "planningProviderId", "planningModelId",
    "approvalRequired", "contextTokenBudget", "planExpiration", "failurePolicy",
  ]);
  const unknown = Object.keys(input).find((field) => !allowed.has(field));
  if (unknown) return { ok: false, error: `Unknown planning field: ${unknown}` };

  const planningEnabled = input.planningEnabled ?? KEY_PLANNING_DEFAULT.planningEnabled;
  const planningMode = String(input.planningMode ?? (planningEnabled ? "MANUAL" : "OFF")).toUpperCase();
  const approvalRequired = input.approvalRequired ?? KEY_PLANNING_DEFAULT.approvalRequired;
  const failurePolicy = String(input.failurePolicy ?? KEY_PLANNING_DEFAULT.failurePolicy).toUpperCase();
  if (typeof planningEnabled !== "boolean") return { ok: false, error: "planningEnabled must be a boolean" };
  if (!KEY_PLANNING_MODES.includes(planningMode)) return { ok: false, error: "planningMode must be OFF, MANUAL, or ADAPTIVE" };
  if (typeof approvalRequired !== "boolean") return { ok: false, error: "approvalRequired must be a boolean" };
  if (!KEY_PLANNING_FAILURE_POLICIES.includes(failurePolicy)) {
    return { ok: false, error: "failurePolicy must be LEGACY_PATH or FAIL_CLOSED" };
  }
  if (planningEnabled && planningMode === "OFF") return { ok: false, error: "Enabled planning requires MANUAL or ADAPTIVE mode" };
  if (!planningEnabled && planningMode !== "OFF") return { ok: false, error: "Disabled planning requires OFF mode" };

  const provider = cleanOptionalId(input.planningProviderId, "planningProviderId", 120);
  if (!provider.ok) return provider;
  const model = cleanOptionalId(input.planningModelId, "planningModelId", 240);
  if (!model.ok) return model;
  if (planningEnabled && (!provider.value || !model.value)) {
    return { ok: false, error: "Enabled planning requires planningProviderId and planningModelId" };
  }

  const contextTokenBudget = Number(input.contextTokenBudget ?? KEY_PLANNING_DEFAULT.contextTokenBudget);
  if (!Number.isSafeInteger(contextTokenBudget) || contextTokenBudget < 256 || contextTokenBudget > 16000) {
    return { ok: false, error: "contextTokenBudget must be an integer from 256 to 16000" };
  }
  const planExpiration = Number(input.planExpiration ?? KEY_PLANNING_DEFAULT.planExpiration);
  if (!Number.isSafeInteger(planExpiration) || planExpiration < 5 || planExpiration > 43200) {
    return { ok: false, error: "planExpiration must be an integer from 5 to 43200 minutes" };
  }

  return {
    ok: true,
    value: {
      planningEnabled,
      planningMode,
      planningProviderId: provider.value,
      planningModelId: model.value,
      approvalRequired,
      contextTokenBudget,
      planExpiration,
      failurePolicy,
    },
  };
}

export function keyPlanningToColumns(value) {
  const checked = validateKeyPlanningInput(value);
  if (!checked.ok) return checked;
  const planning = checked.value;
  return {
    ok: true,
    value: {
      planningEnabled: planning.planningEnabled ? 1 : 0,
      planningMode: planning.planningMode,
      planningProviderId: planning.planningProviderId,
      planningModelId: planning.planningModelId,
      planningApprovalRequired: planning.approvalRequired ? 1 : 0,
      planningContextTokenBudget: planning.contextTokenBudget,
      planningPlanExpirationMinutes: planning.planExpiration,
      planningFailurePolicy: planning.failurePolicy,
    },
  };
}
