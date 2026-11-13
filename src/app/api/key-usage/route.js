import { KEY_EFFORT_VALUES } from "@/shared/utils/keyEffort.js";
import { NextResponse } from "next/server";
import { getApiKeyUsageSummary } from "@/lib/usageDb.js";
import { getApiKeyByKey, updateApiKey } from "@/lib/localDb.js";
import { extractClientApiKey } from "@/shared/utils/requestApiKey.js";
import { findAllowedModel } from "@/shared/utils/keyModelRouting.js";
import {
  assignApiKeyToProject,
  createProject,
  getEffectiveUserProjectAccess,
  getApiKeyProjectAssignment,
  listAssignableProjectsForKey,
} from "@/lib/projectMemory/repository.js";
import { consumeProjectApiBudget } from "@/lib/projectMemory/rateLimit.js";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function visibilityFromKeyRecord(keyRecord) {
  return {
    allowKeyUsage: keyRecord?.allowKeyUsage !== false,
    canViewModelList: keyRecord?.allowKeyUsageModelList !== false,
  };
}

function usageDisabledResponse() {
  return NextResponse.json(
    { error: "Key Usage is disabled for this API key." },
    { status: 403, headers: NO_STORE_HEADERS },
  );
}

function visibleSummary(summary, canViewModelList) {
  const response = {
    ...summary,
    permissions: { canViewModelList },
  };
  if (!canViewModelList) {
    delete response.modelAccess;
    delete response.models;
    if (response.effortPolicy) {
      response.effortPolicy = { ...response.effortPolicy };
      delete response.effortPolicy.overrides;
    }
  }
  return response;
}

function planningSummary(keyRecord) {
  const enabled = keyRecord?.planning?.planningEnabled === true
    && ["MANUAL", "ADAPTIVE"].includes(keyRecord?.planning?.planningMode);
  return {
    enabled,
    mode: enabled ? keyRecord.planning.planningMode : "OFF",
    approvalRequired: true,
    failurePolicy: enabled ? keyRecord.planning.failurePolicy : "FAIL_CLOSED",
    canToggle: keyRecord?.planning?.selfServiceEnabled === true,
  };
}

async function projectAssignmentSummary(keyRecord) {
  const access = keyRecord?.ownerId ? await getEffectiveUserProjectAccess(keyRecord.ownerId) : null;
  const canUseProjects = keyRecord?.projectAccess === true && access?.effective === true;
  if (!canUseProjects) {
    return {
      canUseProjects: false,
      assignment: null,
      projects: [],
      maxProjects: keyRecord?.maxProjects ?? null,
      createdProjectCount: keyRecord?.createdProjectCount ?? 0,
    };
  }
  const [assignment, projects] = await Promise.all([
    getApiKeyProjectAssignment(keyRecord.id),
    listAssignableProjectsForKey(keyRecord),
  ]);
  return {
    canUseProjects: true,
    maxProjects: keyRecord?.maxProjects ?? null,
    createdProjectCount: keyRecord?.createdProjectCount ?? 0,
    assignment: assignment ? { projectId: assignment.projectId, name: assignment.name, status: assignment.status, assignedAt: assignment.assignedAt } : null,
    projects: projects.filter((project) => ["owner", "editor"].includes(project.role)).map((project) => ({ id: project.id, name: project.name, description: project.description, status: project.status })),
  };
}

function enforceProjectBudget(keyRecord, request) {
  const budget = consumeProjectApiBudget(`key:${keyRecord.id}`, request);
  if (budget.allowed) return null;
  return NextResponse.json(
    { error: "Project API rate limit exceeded", code: "PROJECT_RATE_LIMIT" },
    { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": String(budget.retryAfter) } },
  );
}

function updatedPreferences(updated, canViewModelList) {
  const effortPolicy = { ...updated.effortPolicy };
  if (!canViewModelList) delete effortPolicy.overrides;
  const response = {
    effortPolicy,
    permissions: { canViewModelList },
  };
  if (canViewModelList) {
    response.modelAccess = {
      restricted: updated.access.restricted === true,
      allowedModels: [...updated.access.allow],
      publicModel: updated.modelRouting.alias,
      selectedModel: updated.modelRouting.selectedModel,
    };
  }
  return response;
}

export async function GET(request) {
  try {
    const apiKey = extractClientApiKey(request);
    const keyRecord = await getApiKeyByKey(apiKey);

    // Keep missing, unknown and disabled keys indistinguishable so this public
    // endpoint cannot be used to enumerate issued keys or their state.
    if (!keyRecord?.isActive || keyRecord.isExpired) {
      return NextResponse.json(
        { error: "API key is invalid or inactive." },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }
    const rateLimited = enforceProjectBudget(keyRecord, request);
    if (rateLimited) return rateLimited;
    const visibility = visibilityFromKeyRecord(keyRecord);
    if (!visibility.allowKeyUsage) return usageDisabledResponse();
    const summary = await getApiKeyUsageSummary(apiKey, keyRecord);
    if (!summary) {
      return NextResponse.json(
        { error: "API key is invalid or inactive." },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }

    return NextResponse.json(
      {
        ...visibleSummary(summary, visibility.canViewModelList),
        projectAssignment: await projectAssignmentSummary(keyRecord),
        planning: planningSummary(keyRecord),
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[API] Failed to get API key usage:", error);
    return NextResponse.json(
      { error: "Unable to load usage right now." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

export async function PATCH(request) {
  try {
    const apiKey = extractClientApiKey(request);
    const keyRecord = await getApiKeyByKey(apiKey);
    if (!keyRecord?.isActive || keyRecord.isExpired) {
      return NextResponse.json(
        { error: "API key is invalid or inactive." },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }
    const rateLimited = enforceProjectBudget(keyRecord, request);
    if (rateLimited) return rateLimited;
    const visibility = visibilityFromKeyRecord(keyRecord);
    if (!visibility.allowKeyUsage) return usageDisabledResponse();
    const body = await request.json().catch(() => null);
    const allowedFields = ["selectedModel", "selectedEffort", "projectId", "createProject", "planning"];
    if (!body || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(k => !allowedFields.includes(k))) {
      return NextResponse.json({ error: "Only selectedModel, selectedEffort, projectId, createProject, and planning may be changed" }, { status: 400, headers: NO_STORE_HEADERS });
    }
    if (Object.hasOwn(body, "projectId") && Object.hasOwn(body, "createProject")) {
      return NextResponse.json({ error: "Choose an existing project or create a new one, not both" }, { status: 400, headers: NO_STORE_HEADERS });
    }
    const updates = {};
    if (body.planning !== undefined) {
      if (!keyRecord.planning?.selfServiceEnabled) {
        return NextResponse.json({ error: "Planning toggle is controlled by the administrator", code: "KEY_PLANNING_FORBIDDEN" }, { status: 403, headers: NO_STORE_HEADERS });
      }
      if (!body.planning || typeof body.planning !== "object" || Array.isArray(body.planning)) {
        return NextResponse.json({ error: "planning must be an object" }, { status: 400, headers: NO_STORE_HEADERS });
      }
      const forbidden = Object.keys(body.planning).find((field) => !["planningEnabled", "planningMode"].includes(field));
      if (forbidden) return NextResponse.json({ error: `${forbidden} is controlled by the administrator`, code: "KEY_PLANNING_ADMIN_ONLY" }, { status: 403, headers: NO_STORE_HEADERS });
      if (body.planning.planningEnabled !== undefined && typeof body.planning.planningEnabled !== "boolean") {
        return NextResponse.json({ error: "planningEnabled must be a boolean" }, { status: 400, headers: NO_STORE_HEADERS });
      }
      if (body.planning.planningMode !== undefined && !["OFF", "MANUAL", "ADAPTIVE"].includes(String(body.planning.planningMode).toUpperCase())) {
        return NextResponse.json({ error: "planningMode must be OFF, MANUAL, or ADAPTIVE" }, { status: 400, headers: NO_STORE_HEADERS });
      }
      updates.planning = body.planning;
    }
    if (body.selectedModel !== undefined) {
      if (!visibility.canViewModelList) {
        return NextResponse.json(
          { error: "Model viewing and selection are disabled for this API key." },
          { status: 403, headers: NO_STORE_HEADERS },
        );
      }
      if (!keyRecord.modelRouting?.alias || typeof body.selectedModel !== "string") return NextResponse.json({ error: "Public model name required to select a target" }, { status: 400, headers: NO_STORE_HEADERS });
      const selectedModel = findAllowedModel(keyRecord.access.allow, body.selectedModel);
      if (!selectedModel) return NextResponse.json({ error: "Selected model is not allowed for this API key" }, { status: 403, headers: NO_STORE_HEADERS });
      updates.modelRouting = { alias: keyRecord.modelRouting.alias, selectedModel };
    }
    if (Object.hasOwn(body, "selectedEffort")) {
      if (!keyRecord.effortPolicy?.allowUserChoice) return NextResponse.json({ error: "Effort is controlled by the administrator" }, { status: 403, headers: NO_STORE_HEADERS });
      if (body.selectedEffort !== null && !KEY_EFFORT_VALUES.includes(body.selectedEffort)) return NextResponse.json({ error: "Invalid effort level" }, { status: 400, headers: NO_STORE_HEADERS });
      updates.selectedEffort = body.selectedEffort;
    }
    // The repository rechecks Key Usage and effort access inside the write transaction.
    const updated = Object.keys(updates).length
      ? await updateApiKey(keyRecord.id, updates, { keyUsageSelfService: true })
      : keyRecord;
    if (Object.hasOwn(body, "projectId")) {
      if (body.projectId !== null && typeof body.projectId !== "string") return NextResponse.json({ error: "projectId must be a string or null" }, { status: 400, headers: NO_STORE_HEADERS });
      await assignApiKeyToProject(keyRecord.id, body.projectId, null, { selfService: true });
    }
    if (Object.hasOwn(body, "createProject")) {
      if (!body.createProject || typeof body.createProject !== "object" || Array.isArray(body.createProject)) return NextResponse.json({ error: "Invalid project details" }, { status: 400, headers: NO_STORE_HEADERS });
      const project = await createProject(
        body.createProject,
        {
          principalId: keyRecord.ownerId,
          displayName: "API key owner",
        },
        { apiKeyId: keyRecord.id },
      );
      await assignApiKeyToProject(keyRecord.id, project.id, null, { selfService: true });
    }
    const finalRecord = Object.hasOwn(body, "createProject") || Object.hasOwn(body, "projectId")
      ? (await getApiKeyByKey(apiKey)) || updated
      : updated;
    return NextResponse.json(
      {
        ...updatedPreferences(finalRecord, visibility.canViewModelList),
        projectAssignment: await projectAssignmentSummary(finalRecord),
        planning: planningSummary(finalRecord),
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[API] Failed to update API key model selection:", error);
    if (error?.code === "KEY_EFFORT_FORBIDDEN") return NextResponse.json({ error: "Effort is controlled by the administrator" }, { status: 403, headers: NO_STORE_HEADERS });
    if (error?.code === "KEY_USAGE_FORBIDDEN") return usageDisabledResponse();
    if (error?.code === "KEY_PLANNING_FORBIDDEN" || error?.code === "KEY_PLANNING_ADMIN_ONLY") {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403, headers: NO_STORE_HEADERS });
    }
    if (error?.code === "INVALID_KEY_PLANNING") {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400, headers: NO_STORE_HEADERS });
    }
    if (error?.code === "KEY_USAGE_MODEL_LIST_FORBIDDEN") {
      return NextResponse.json(
        { error: "Model viewing and selection are disabled for this API key." },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
    if (error?.code === "INVALID_KEY_EFFORT") return NextResponse.json({ error: "Invalid effort level" }, { status: 400, headers: NO_STORE_HEADERS });
    if (error?.code === "INVALID_KEY_MODEL_ROUTING") {
      return NextResponse.json(
        { error: "The allowed model configuration changed. Reload and try again." },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      return NextResponse.json({ error: error.message, code: error.code || "PROJECT_ERROR" }, { status: error.status, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json(
      { error: "Unable to update the selected model right now." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
