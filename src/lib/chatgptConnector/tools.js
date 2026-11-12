import { getAdapter } from "@/lib/db/driver.js";
import { getRelatedFiles, listProjectFiles } from "@/lib/projectMemory/fileIntelligence.js";
import { graphStats } from "@/lib/projectMemory/graphRepository.js";
import { listMemories } from "@/lib/projectMemory/memoryRepository.js";
import {
  getProjectById,
  getProjectSettings,
  requireProjectRole,
} from "@/lib/projectMemory/repository.js";
import { getPlan, listPlans } from "@/lib/planning/service.js";
import { importValidatedPlanDraft } from "@/lib/planning/repository.js";
import { PLAN_OUTPUT_SCHEMA, validatePlanningOutput } from "@/lib/planning/schema.js";
import { redactProjectText } from "@/lib/projectMemory/privacy.js";
import {
  CHATGPT_CONNECTOR_LIMITS,
  UNTRUSTED_PROJECT_NOTICE,
  connectorError,
} from "./constants.js";
import { sanitizeConnectorData, sha256 } from "./security.js";
import { requireConnectorScope } from "./repository.js";

function numberInRange(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function textArg(value, name, max, { required = false } = {}) {
  if (value == null && !required) return "";
  if (typeof value !== "string") throw connectorError("MCP_ARGUMENT_INVALID", `${name} must be a string`, 400);
  const clean = value.replace(/\u0000/g, "").trim();
  if (required && !clean) throw connectorError("MCP_ARGUMENT_INVALID", `${name} is required`, 400);
  if (clean.length > max) throw connectorError("MCP_ARGUMENT_INVALID", `${name} exceeds ${max} characters`, 400);
  return clean;
}

function identity(auth) {
  return { principalId: auth.principalId, authType: "chatgpt-connector", apiKeyId: null };
}

function result(data) {
  return sanitizeConnectorData({ notice: UNTRUSTED_PROJECT_NOTICE, ...data });
}

async function getProjectOverview(args, auth) {
  requireConnectorScope(auth, "project.read");
  const project = await getProjectById(auth.projectId, auth.principalId);
  const settings = await getProjectSettings(auth.projectId, auth.principalId);
  const graph = await graphStats(auth.projectId);
  const db = await getAdapter();
  const counts = db.get(
    `SELECT
      (SELECT COUNT(*) FROM memoryItems WHERE projectId=? AND status IN ('active','pinned')) AS memories,
      (SELECT COUNT(*) FROM projectFiles WHERE projectId=? AND indexingStatus IN ('indexed','updated')) AS files,
      (SELECT COUNT(*) FROM projectSymbols WHERE projectId=?) AS symbols,
      (SELECT COUNT(*) FROM executionPlans WHERE projectId=?) AS plans`,
    [auth.projectId, auth.projectId, auth.projectId, auth.projectId],
  );
  return result({ project, settings, graph, counts });
}

async function searchProjectMemory(args, auth) {
  requireConnectorScope(auth, "memory.read");
  const query = textArg(args.query || "", "query", 300);
  const type = textArg(args.type || "", "type", 80);
  const memories = await listMemories(auth.projectId, auth.principalId, {
    q: query,
    type,
    status: args.status || "",
    limit: numberInRange(args.limit, 1, 50, 20),
    offset: numberInRange(args.offset, 0, 10_000, 0),
  });
  return result({ memories });
}

async function searchProjectFiles(args, auth) {
  requireConnectorScope(auth, "files.read");
  const files = await listProjectFiles(auth.projectId, auth.principalId, {
    q: textArg(args.query || "", "query", 300),
    status: args.status || "",
    limit: numberInRange(args.limit, 1, 100, 30),
    offset: numberInRange(args.offset, 0, 100_000, 0),
  });
  return result({ files });
}

async function getSymbolInfo(args, auth) {
  requireConnectorScope(auth, "files.read");
  await requireProjectRole(auth.projectId, auth.principalId);
  const name = textArg(args.name || "", "name", 300);
  const fileId = textArg(args.file_id || "", "file_id", 200);
  if (!name && !fileId) throw connectorError("MCP_ARGUMENT_INVALID", "name or file_id is required", 400);
  const db = await getAdapter();
  const where = ["s.projectId=?"];
  const params = [auth.projectId];
  if (name) {
    where.push("(s.name LIKE ? ESCAPE '\\' OR s.qualifiedName LIKE ? ESCAPE '\\')");
    const escaped = `%${name.replace(/[\\%_]/g, "\\$&")}%`;
    params.push(escaped, escaped);
  }
  if (fileId) { where.push("s.fileId=?"); params.push(fileId); }
  params.push(numberInRange(args.limit, 1, 100, 30));
  const symbols = db.all(
    `SELECT s.id, s.fileId, s.symbolType, s.name, s.qualifiedName, s.lineStart, s.lineEnd,
      s.signature, s.metadata, pf.relativePath AS filePath
     FROM projectSymbols s JOIN projectFiles pf ON pf.id=s.fileId
     WHERE ${where.join(" AND ")} ORDER BY pf.relativePath, s.lineStart LIMIT ?`,
    params,
  );
  return result({ symbols });
}

async function getRelatedProjectFiles(args, auth) {
  requireConnectorScope(auth, "files.read");
  const fileId = textArg(args.file_id, "file_id", 200, { required: true });
  const related = await getRelatedFiles(
    auth.projectId,
    fileId,
    auth.principalId,
    numberInRange(args.depth, 1, 4, 1),
  );
  return result({ related });
}

async function getProjectConstraints(args, auth) {
  requireConnectorScope(auth, "project.read");
  requireConnectorScope(auth, "memory.read");
  const settings = await getProjectSettings(auth.projectId, auth.principalId);
  const constraints = await listMemories(auth.projectId, auth.principalId, {
    type: "constraint",
    status: "active",
    limit: numberInRange(args.limit, 1, 100, 50),
  });
  const decisions = await listMemories(auth.projectId, auth.principalId, {
    type: "decision",
    status: "active",
    limit: numberInRange(args.limit, 1, 100, 50),
  });
  return result({ settings, constraints, decisions });
}

function planSummary(plan) {
  return {
    id: plan.id,
    projectId: plan.projectId,
    status: plan.status,
    version: plan.version,
    currentRevision: plan.currentRevision,
    originalRequest: plan.originalRequest,
    interpretedObjective: plan.interpretedObjective,
    assumptions: plan.assumptions,
    missingInformation: plan.missingInformation,
    constraints: plan.constraints,
    affectedModules: plan.affectedModules,
    risks: plan.risks,
    selectedOptionId: plan.selectedOptionId,
    options: plan.options,
    revisions: Array.isArray(plan.revisions) ? plan.revisions.slice(0, 10) : undefined,
    approval: plan.approval || null,
    expiresAt: plan.expiresAt,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

async function getPlanDraft(args, auth) {
  requireConnectorScope(auth, "plans.read");
  const planId = textArg(args.plan_id || "", "plan_id", 200);
  if (planId) return result({ plan: planSummary(await getPlan(auth.projectId, planId, identity(auth))) });
  const plans = await listPlans(auth.projectId, identity(auth), {
    status: args.status || null,
    limit: numberInRange(args.limit, 1, 20, 10),
  });
  return result({ plans: plans.map(planSummary) });
}

async function submitPlanDraft(args, auth) {
  requireConnectorScope(auth, "plan.submit");
  if (!auth.allowPlanSubmit) throw connectorError("MCP_INSUFFICIENT_SCOPE", "This connector is read-only", 403);
  const originalRequestRaw = textArg(args.original_request, "original_request", 32_000, { required: true });
  const originalRequest = redactProjectText(originalRequestRaw).text;
  const idempotencyKey = textArg(args.idempotency_key, "idempotency_key", 200, { required: true });
  if (idempotencyKey.length < 16) throw connectorError("MCP_ARGUMENT_INVALID", "idempotency_key must contain at least 16 characters", 400);
  const checked = validatePlanningOutput(args.plan);
  if (!checked.ok) throw connectorError("PLAN_SCHEMA_INVALID", "Submitted plan does not match the Planning schema", 400, { errors: checked.errors });
  const expirationMinutes = numberInRange(args.expiration_minutes, 5, 43_200, 10_080);
  const plan = await importValidatedPlanDraft({
    projectId: auth.projectId,
    originalRequest,
    output: checked.value,
    connectorId: auth.connectorId,
    idempotencyHash: sha256(`${auth.connectorId}\u0000${idempotencyKey}`),
    expiresAt: new Date(Date.now() + expirationMinutes * 60_000).toISOString(),
  }, identity(auth));
  return result({
    plan: planSummary(plan),
    approvalRequired: true,
    nextStep: "Review, select an option, and approve this plan in the authenticated 9Router dashboard.",
  });
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const CHATGPT_MCP_TOOLS = Object.freeze([
  {
    name: "get_project_overview",
    title: "Get project overview",
    description: `Return bounded project metadata, settings and counts. ${UNTRUSTED_PROJECT_NOTICE}`,
    requiredScope: "project.read",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: readOnly,
    execute: getProjectOverview,
  },
  {
    name: "search_project_memory",
    title: "Search project memory",
    description: `Search bounded structured Project Memory with provenance. ${UNTRUSTED_PROJECT_NOTICE}`,
    requiredScope: "memory.read",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 300 }, type: { type: "string", maxLength: 80 },
        status: { type: "string", maxLength: 80 }, limit: { type: "integer", minimum: 1, maximum: 50 },
        offset: { type: "integer", minimum: 0 },
      },
    },
    annotations: readOnly,
    execute: searchProjectMemory,
  },
  {
    name: "search_project_files",
    title: "Search indexed project files",
    description: `Search secret-filtered File Intelligence metadata. It cannot read the host filesystem. ${UNTRUSTED_PROJECT_NOTICE}`,
    requiredScope: "files.read",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 300 }, status: { type: "string", maxLength: 80 },
        limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 },
      },
    },
    annotations: readOnly,
    execute: searchProjectFiles,
  },
  {
    name: "get_symbol_info",
    title: "Get indexed symbol information",
    description: `Return bounded symbols from File Intelligence. ${UNTRUSTED_PROJECT_NOTICE}`,
    requiredScope: "files.read",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        name: { type: "string", maxLength: 300 }, file_id: { type: "string", maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    annotations: readOnly,
    execute: getSymbolInfo,
  },
  {
    name: "get_related_files",
    title: "Get related indexed files",
    description: `Traverse verified indexed file dependencies within this project only. ${UNTRUSTED_PROJECT_NOTICE}`,
    requiredScope: "files.read",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["file_id"],
      properties: { file_id: { type: "string", minLength: 1, maxLength: 200 }, depth: { type: "integer", minimum: 1, maximum: 4 } },
    },
    annotations: readOnly,
    execute: getRelatedProjectFiles,
  },
  {
    name: "get_project_constraints",
    title: "Get project constraints",
    description: `Return Project settings plus verified constraint and decision memory. ${UNTRUSTED_PROJECT_NOTICE}`,
    requiredScope: "project.read",
    requiredScopes: ["memory.read"],
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
    annotations: readOnly,
    execute: getProjectConstraints,
  },
  {
    name: "get_plan_draft",
    title: "Get plan draft",
    description: `Read one plan or list recent plans. This never approves or executes a plan. ${UNTRUSTED_PROJECT_NOTICE}`,
    requiredScope: "plans.read",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        plan_id: { type: "string", maxLength: 200 }, status: { type: "string", maxLength: 80 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
    },
    annotations: readOnly,
    execute: getPlanDraft,
  },
  {
    name: "submit_plan_draft",
    title: "Submit plan draft",
    description: "Submit a schema-validated draft into 9Router. This cannot select, approve, or execute the plan.",
    requiredScope: "plan.submit",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["original_request", "plan", "idempotency_key"],
      properties: {
        original_request: { type: "string", minLength: 1, maxLength: 32_000 },
        plan: PLAN_OUTPUT_SCHEMA,
        idempotency_key: { type: "string", minLength: 16, maxLength: 200 },
        expiration_minutes: { type: "integer", minimum: 5, maximum: 43_200 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: submitPlanDraft,
  },
]);

export function visibleTools(auth) {
  return CHATGPT_MCP_TOOLS.filter((tool) => auth.scopes.includes(tool.requiredScope)
    && (!tool.requiredScopes || tool.requiredScopes.every((scope) => auth.scopes.includes(scope))));
}

function validateToolArguments(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw connectorError("MCP_ARGUMENT_INVALID", "Tool arguments must be an object", 400);
  }
  const schema = tool.inputSchema || {};
  const properties = schema.properties || {};
  for (const required of schema.required || []) {
    if (!Object.hasOwn(args, required)) throw connectorError("MCP_ARGUMENT_INVALID", `${required} is required`, 400);
  }
  if (schema.additionalProperties === false) {
    const extra = Object.keys(args).find((key) => !Object.hasOwn(properties, key));
    if (extra) throw connectorError("MCP_ARGUMENT_INVALID", `${extra} is not allowed`, 400);
  }
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key];
    if (!rule || value == null) continue;
    if (rule.type === "string" && typeof value !== "string") throw connectorError("MCP_ARGUMENT_INVALID", `${key} must be a string`, 400);
    if (rule.type === "integer" && !Number.isSafeInteger(value)) throw connectorError("MCP_ARGUMENT_INVALID", `${key} must be an integer`, 400);
    if (rule.type === "boolean" && typeof value !== "boolean") throw connectorError("MCP_ARGUMENT_INVALID", `${key} must be a boolean`, 400);
    if (rule.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw connectorError("MCP_ARGUMENT_INVALID", `${key} must be an object`, 400);
    }
    if (typeof value === "string" && rule.maxLength && value.length > rule.maxLength) throw connectorError("MCP_ARGUMENT_INVALID", `${key} is too long`, 400);
    if (typeof value === "string" && rule.minLength && value.length < rule.minLength) throw connectorError("MCP_ARGUMENT_INVALID", `${key} is too short`, 400);
    if (Number.isFinite(value) && rule.minimum != null && value < rule.minimum) throw connectorError("MCP_ARGUMENT_INVALID", `${key} is below the minimum`, 400);
    if (Number.isFinite(value) && rule.maximum != null && value > rule.maximum) throw connectorError("MCP_ARGUMENT_INVALID", `${key} exceeds the maximum`, 400);
  }
}

export async function executeConnectorTool(name, args, auth, {
  timeoutMs = CHATGPT_CONNECTOR_LIMITS.toolTimeoutMs,
  tools = CHATGPT_MCP_TOOLS,
} = {}) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw connectorError("MCP_TOOL_NOT_FOUND", `Unknown tool ${name}`, 404);
  requireConnectorScope(auth, tool.requiredScope);
  for (const scope of tool.requiredScopes || []) requireConnectorScope(auth, scope);
  const safeArgs = args && typeof args === "object" && !Array.isArray(args) ? args : args;
  validateToolArguments(tool, safeArgs);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => tool.execute(safeArgs, auth)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(connectorError("MCP_TOOL_TIMEOUT", "Tool execution timed out", 504)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const __test__ = { textArg, numberInRange, planSummary, result, validateToolArguments };
