import { v4 as uuidv4 } from "uuid";
import { createHash } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { redactProjectText } from "@/lib/projectMemory/privacy.js";
import { requireProjectRole } from "@/lib/projectMemory/repository.js";
import {
  PHASE_ONE_MUTABLE_STATUSES,
  planningError,
} from "./constants.js";

const MUTABLE = new Set(PHASE_ONE_MUTABLE_STATUSES);

function parsePlanRow(row) {
  if (!row) return null;
  return {
    ...row,
    assumptions: parseJson(row.assumptions, []),
    missingInformation: parseJson(row.missingInformation, []),
    constraints: parseJson(row.constraints, []),
    affectedModules: parseJson(row.affectedModules, []),
    risks: parseJson(row.risks, []),
  };
}

function parseOptionRow(row) {
  if (!row) return null;
  return { ...parseJson(row.content, {}), id: row.id, ordinal: row.ordinal, recommended: row.recommended === 1 };
}

function parseRevisionRow(row) {
  if (!row) return null;
  return { ...row, content: parseJson(row.content, {}), usage: parseJson(row.usage, {}) };
}

function parseAuditRow(row) {
  return row ? { ...row, metadata: parseJson(row.metadata, {}) } : null;
}

function parseApprovalRow(row) {
  if (!row) return null;
  const { nonceHash: _nonceHash, ...approval } = row;
  return approval;
}

function audit(db, { planId, projectId, actorId, eventType, fromStatus = null, toStatus = null, planVersion, metadata = {} }) {
  db.run(
    `INSERT INTO planAuditLogs(id, planId, projectId, actorId, eventType, fromStatus, toStatus, planVersion, metadata, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), planId, projectId, actorId, eventType, fromStatus, toStatus, planVersion, JSON.stringify(metadata), new Date().toISOString()],
  );
}

function assertPlan(row, expectedVersion = null) {
  if (!row) throw planningError("PLAN_NOT_FOUND", "Plan not found", 404);
  if (expectedVersion !== null && row.version !== expectedVersion) {
    throw planningError("PLAN_VERSION_CONFLICT", "Plan version is stale", 409, { currentVersion: row.version });
  }
  return row;
}

function assertMutable(row) {
  if (!MUTABLE.has(row.status)) {
    throw planningError("PLAN_STATE_CONFLICT", `Plan cannot be changed from ${row.status}`, 409);
  }
}

function expirePlanInTransaction(db, row) {
  if (!row?.expiresAt || !MUTABLE.has(row.status) || Date.parse(row.expiresAt) > Date.now()) return row;
  const now = new Date().toISOString();
  const changed = db.run(
    "UPDATE executionPlans SET status='EXPIRED', version=version+1, updatedAt=? WHERE id=? AND version=?",
    [now, row.id, row.version],
  )?.changes || 0;
  if (!changed) return db.get("SELECT * FROM executionPlans WHERE id=?", [row.id]);
  audit(db, {
    planId: row.id,
    projectId: row.projectId,
    actorId: "system",
    eventType: "PLAN_EXPIRED",
    fromStatus: row.status,
    toStatus: "EXPIRED",
    planVersion: row.version + 1,
  });
  return db.get("SELECT * FROM executionPlans WHERE id=?", [row.id]);
}

async function requireRead(projectId, identity) {
  return requireProjectRole(projectId, identity.principalId, ["owner", "editor", "viewer"]);
}

async function requireWrite(projectId, identity) {
  return requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
}

export async function createDraftPlan({
  projectId,
  originalRequest,
  providerId,
  modelId,
  context,
  expiresAt,
  apiKeyId = null,
}, identity) {
  await requireWrite(projectId, identity);
  const db = await getAdapter();
  const id = uuidv4();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.run(
      `INSERT INTO executionPlans(
        id, projectId, createdBy, apiKeyId, providerId, modelId, status, version, currentRevision,
        originalRequest, contextSnapshotId, contextHash, contextTokenEstimate, expiresAt, createdAt, updatedAt
       ) VALUES(?, ?, ?, ?, ?, ?, 'DRAFT', 1, 0, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, projectId, identity.principalId, apiKeyId, providerId, modelId, originalRequest,
        context?.snapshot?.id || null, context?.contentHash || null, context?.tokenEstimate || 0,
        expiresAt, now, now,
      ],
    );
    audit(db, {
      planId: id,
      projectId,
      actorId: identity.principalId,
      eventType: "PLAN_CREATED",
      toStatus: "DRAFT",
      planVersion: 1,
      metadata: { providerId, modelId, contextSnapshotId: context?.snapshot?.id || null },
    });
  });
  return parsePlanRow(db.get("SELECT * FROM executionPlans WHERE id=?", [id]));
}

export async function commitPlanRevision({
  projectId,
  planId,
  expectedVersion,
  output,
  usage = {},
  feedback = null,
  sourceRevision = null,
}, identity) {
  await requireWrite(projectId, identity);
  const db = await getAdapter();
  db.transaction(() => {
    const current = assertPlan(expirePlanInTransaction(
      db,
      db.get("SELECT * FROM executionPlans WHERE id=? AND projectId=?", [planId, projectId]),
    ), expectedVersion);
    assertMutable(current);
    const revision = current.currentRevision + 1;
    const requiredQuestions = output.missingInformation.filter((item) => item.required);
    const status = requiredQuestions.length ? "NEEDS_CLARIFICATION" : "OPTIONS_READY";
    const now = new Date().toISOString();
    const updated = db.run(
      `UPDATE executionPlans SET status=?, version=version+1, currentRevision=?, selectedOptionId=NULL,
       interpretedObjective=?, assumptions=?, missingInformation=?, constraints=?, affectedModules=?, risks=?,
       errorCode=NULL, errorMessage=NULL, updatedAt=? WHERE id=? AND projectId=? AND version=?`,
      [
        status, revision, output.interpretedObjective, JSON.stringify(output.assumptions),
        JSON.stringify(output.missingInformation), JSON.stringify(output.constraints),
        JSON.stringify(output.affectedModules), JSON.stringify(output.risks), now,
        planId, projectId, expectedVersion,
      ],
    )?.changes || 0;
    if (!updated) throw planningError("PLAN_VERSION_CONFLICT", "Plan version is stale", 409);
    db.run(
      `INSERT INTO planRevisions(id, planId, revision, sourceRevision, createdBy, feedback, content, usage, createdAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), planId, revision, sourceRevision, identity.principalId, feedback, JSON.stringify(output), JSON.stringify(usage), now],
    );
    output.options.forEach((option, ordinal) => {
      db.run(
        `INSERT INTO planOptions(id, planId, revision, ordinal, name, summary, content, recommended, createdAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), planId, revision, ordinal, option.name, option.summary, JSON.stringify(option), output.recommendedOptionIndex === ordinal ? 1 : 0, now],
      );
    });
    audit(db, {
      planId,
      projectId,
      actorId: identity.principalId,
      eventType: revision === 1 ? "PLAN_GENERATED" : "PLAN_REVISED",
      fromStatus: current.status,
      toStatus: status,
      planVersion: expectedVersion + 1,
      metadata: { revision, sourceRevision, optionCount: output.options.length, providerUsage: usage },
    });
  });
  return getPlan(projectId, planId, identity);
}

export async function recordPlanningFailure({ projectId, planId, expectedVersion, error, operation }, identity) {
  await requireWrite(projectId, identity);
  const db = await getAdapter();
  db.transaction(() => {
    const current = assertPlan(expirePlanInTransaction(
      db,
      db.get("SELECT * FROM executionPlans WHERE id=? AND projectId=?", [planId, projectId]),
    ), expectedVersion);
    const isInitial = current.status === "DRAFT" && current.currentRevision === 0;
    const nextVersion = isInitial ? current.version + 1 : current.version;
    if (isInitial) {
      db.run(
        "UPDATE executionPlans SET status='FAILED', version=version+1, errorCode=?, errorMessage=?, updatedAt=? WHERE id=? AND version=?",
        [
          error.code || "PLANNING_FAILED",
          redactProjectText(String(error.message || "Planning failed").slice(0, 2000)).text,
          new Date().toISOString(), planId, expectedVersion,
        ],
      );
    }
    audit(db, {
      planId,
      projectId,
      actorId: identity.principalId,
      eventType: operation === "revision" ? "PLAN_REVISION_FAILED" : "PLAN_GENERATION_FAILED",
      fromStatus: current.status,
      toStatus: isInitial ? "FAILED" : current.status,
      planVersion: nextVersion,
      metadata: { code: error.code || "PLANNING_FAILED" },
    });
  });
}

export async function listPlans(projectId, identity, { status = null, limit = 50 } = {}) {
  await requireRead(projectId, identity);
  const db = await getAdapter();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  db.transaction(() => {
    const expired = db.all(
      `SELECT * FROM executionPlans WHERE projectId=? AND status IN ('DRAFT','NEEDS_CLARIFICATION','OPTIONS_READY','PENDING_APPROVAL')
       AND expiresAt IS NOT NULL AND expiresAt<=?`,
      [projectId, new Date().toISOString()],
    );
    for (const row of expired) expirePlanInTransaction(db, row);
  });
  const rows = status
    ? db.all("SELECT * FROM executionPlans WHERE projectId=? AND status=? ORDER BY updatedAt DESC LIMIT ?", [projectId, status, safeLimit])
    : db.all("SELECT * FROM executionPlans WHERE projectId=? ORDER BY updatedAt DESC LIMIT ?", [projectId, safeLimit]);
  return rows.map(parsePlanRow);
}

export async function getPlan(projectId, planId, identity, { includeHistory = true } = {}) {
  await requireRead(projectId, identity);
  const db = await getAdapter();
  let row;
  db.transaction(() => {
    row = expirePlanInTransaction(db, db.get("SELECT * FROM executionPlans WHERE id=? AND projectId=?", [planId, projectId]));
  });
  assertPlan(row);
  const plan = parsePlanRow(row);
  plan.options = db.all(
    "SELECT * FROM planOptions WHERE planId=? AND revision=? ORDER BY ordinal",
    [planId, row.currentRevision],
  ).map(parseOptionRow);
  if (includeHistory) {
    plan.revisions = db.all("SELECT * FROM planRevisions WHERE planId=? ORDER BY revision DESC", [planId]).map(parseRevisionRow);
    plan.auditLog = db.all("SELECT * FROM planAuditLogs WHERE planId=? ORDER BY createdAt, rowid", [planId]).map(parseAuditRow);
    plan.approval = parseApprovalRow(db.get("SELECT * FROM planApprovals WHERE planId=?", [planId]));
  }
  return plan;
}

export async function listPlanOptions(projectId, planId, identity, revision = null) {
  const plan = await getPlan(projectId, planId, identity, { includeHistory: false });
  const targetRevision = revision == null ? plan.currentRevision : Number(revision);
  const db = await getAdapter();
  return db.all("SELECT * FROM planOptions WHERE planId=? AND revision=? ORDER BY ordinal", [planId, targetRevision]).map(parseOptionRow);
}

export async function listPlanRevisions(projectId, planId, identity) {
  await requireRead(projectId, identity);
  const db = await getAdapter();
  assertPlan(db.get("SELECT id FROM executionPlans WHERE id=? AND projectId=?", [planId, projectId]));
  return db.all("SELECT * FROM planRevisions WHERE planId=? ORDER BY revision DESC", [planId]).map(parseRevisionRow);
}

async function mutateWithVersion({ projectId, planId, expectedVersion, identity, eventType, allowedStatuses, update, metadata = {} }) {
  await requireWrite(projectId, identity);
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const current = assertPlan(expirePlanInTransaction(
      db,
      db.get("SELECT * FROM executionPlans WHERE id=? AND projectId=?", [planId, projectId]),
    ), expectedVersion);
    if (!allowedStatuses.includes(current.status)) {
      throw planningError("PLAN_STATE_CONFLICT", `Plan cannot perform ${eventType} from ${current.status}`, 409);
    }
    const next = update(db, current);
    audit(db, {
      planId,
      projectId,
      actorId: identity.principalId,
      eventType,
      fromStatus: current.status,
      toStatus: next.status,
      planVersion: expectedVersion + 1,
      metadata,
    });
    result = db.get("SELECT * FROM executionPlans WHERE id=?", [planId]);
  });
  return parsePlanRow(result);
}

export async function submitPlanFeedback({ projectId, planId, expectedVersion, feedback }, identity) {
  return mutateWithVersion({
    projectId, planId, expectedVersion, identity,
    eventType: "PLAN_FEEDBACK_SUBMITTED",
    allowedStatuses: PHASE_ONE_MUTABLE_STATUSES,
    metadata: { feedback },
    update(db, current) {
      const changed = db.run(
        "UPDATE executionPlans SET version=version+1, updatedAt=? WHERE id=? AND version=?",
        [new Date().toISOString(), planId, expectedVersion],
      )?.changes || 0;
      if (!changed) throw planningError("PLAN_VERSION_CONFLICT", "Plan version is stale", 409);
      return { status: current.status };
    },
  });
}

export async function selectPlanOption({ projectId, planId, optionId, expectedVersion }, identity) {
  return mutateWithVersion({
    projectId, planId, expectedVersion, identity,
    eventType: "PLAN_OPTION_SELECTED",
    allowedStatuses: ["OPTIONS_READY", "PENDING_APPROVAL"],
    metadata: { optionId },
    update(db, current) {
      const option = db.get(
        "SELECT id FROM planOptions WHERE id=? AND planId=? AND revision=?",
        [optionId, planId, current.currentRevision],
      );
      if (!option) throw planningError("PLAN_OPTION_INVALID", "Option does not belong to the current revision", 400);
      const changed = db.run(
        "UPDATE executionPlans SET selectedOptionId=?, status='OPTIONS_READY', version=version+1, updatedAt=? WHERE id=? AND version=?",
        [optionId, new Date().toISOString(), planId, expectedVersion],
      )?.changes || 0;
      if (!changed) throw planningError("PLAN_VERSION_CONFLICT", "Plan version is stale", 409);
      return { status: "OPTIONS_READY" };
    },
  });
}

export async function requestPlanApproval({ projectId, planId, expectedVersion }, identity) {
  return mutateWithVersion({
    projectId, planId, expectedVersion, identity,
    eventType: "PLAN_APPROVAL_REQUESTED",
    allowedStatuses: ["OPTIONS_READY"],
    update(db, current) {
      if (!current.selectedOptionId) throw planningError("PLAN_OPTION_REQUIRED", "Select an option before requesting approval", 400);
      const changed = db.run(
        "UPDATE executionPlans SET status='PENDING_APPROVAL', version=version+1, updatedAt=? WHERE id=? AND version=?",
        [new Date().toISOString(), planId, expectedVersion],
      )?.changes || 0;
      if (!changed) throw planningError("PLAN_VERSION_CONFLICT", "Plan version is stale", 409);
      return { status: "PENDING_APPROVAL" };
    },
  });
}

export async function decidePlanApproval({
  projectId,
  planId,
  expectedVersion,
  optionId,
  scope,
  idempotencyKey,
  decision,
  reason = "",
}, identity) {
  await requireWrite(projectId, identity);
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const current = assertPlan(expirePlanInTransaction(
      db,
      db.get("SELECT * FROM executionPlans WHERE id=? AND projectId=?", [planId, projectId]),
    ), expectedVersion);
    if (current.status !== "PENDING_APPROVAL") {
      throw planningError("PLAN_STATE_CONFLICT", `Plan cannot be ${decision.toLowerCase()} from ${current.status}`, 409);
    }
    if (scope !== "EXECUTE_APPROVED_PLAN") {
      throw planningError("PLAN_APPROVAL_SCOPE_INVALID", "Approval scope must be EXECUTE_APPROVED_PLAN", 400);
    }
    if (current.selectedOptionId !== optionId) {
      throw planningError("PLAN_OPTION_INVALID", "Approval must reference the selected option", 409);
    }
    const option = db.get(
      "SELECT id FROM planOptions WHERE id=? AND planId=? AND revision=?",
      [optionId, planId, current.currentRevision],
    );
    if (!option) throw planningError("PLAN_OPTION_INVALID", "Selected option does not belong to the current revision", 409);
    if (db.get("SELECT id FROM planApprovals WHERE planId=?", [planId])) {
      throw planningError("PLAN_APPROVAL_CONFLICT", "Plan already has an approval decision", 409);
    }
    const nonceHash = createHash("sha256")
      .update(`${identity.principalId}\u0000${idempotencyKey}`)
      .digest("hex");
    if (db.get("SELECT id FROM planApprovals WHERE nonceHash=?", [nonceHash])) {
      throw planningError("PLAN_APPROVAL_REPLAY", "Approval idempotency key was already used", 409);
    }
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO planApprovals(
        id, planId, projectId, revision, planVersion, optionId, decision, scope, actorId, nonceHash, reason, createdAt
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(), planId, projectId, current.currentRevision, current.version, optionId,
        decision, scope, identity.principalId, nonceHash, reason, now,
      ],
    );
    const changed = db.run(
      "UPDATE executionPlans SET status=?, version=version+1, updatedAt=? WHERE id=? AND projectId=? AND version=? AND status='PENDING_APPROVAL'",
      [decision, now, planId, projectId, expectedVersion],
    )?.changes || 0;
    if (!changed) throw planningError("PLAN_VERSION_CONFLICT", "Plan version is stale", 409);
    audit(db, {
      planId,
      projectId,
      actorId: identity.principalId,
      eventType: decision === "APPROVED" ? "PLAN_APPROVED" : "PLAN_REJECTED",
      fromStatus: current.status,
      toStatus: decision,
      planVersion: expectedVersion + 1,
      metadata: { revision: current.currentRevision, optionId, scope, reason },
    });
    result = db.get("SELECT * FROM executionPlans WHERE id=?", [planId]);
  });
  return parsePlanRow(result);
}

export async function cancelPlan({ projectId, planId, expectedVersion, reason = "" }, identity) {
  return mutateWithVersion({
    projectId, planId, expectedVersion, identity,
    eventType: "PLAN_CANCELLED",
    allowedStatuses: PHASE_ONE_MUTABLE_STATUSES,
    metadata: { reason },
    update(db) {
      const changed = db.run(
        "UPDATE executionPlans SET status='CANCELLED', version=version+1, updatedAt=? WHERE id=? AND version=?",
        [new Date().toISOString(), planId, expectedVersion],
      )?.changes || 0;
      if (!changed) throw planningError("PLAN_VERSION_CONFLICT", "Plan version is stale", 409);
      return { status: "CANCELLED" };
    },
  });
}

export async function importValidatedPlanDraft({
  projectId,
  originalRequest,
  output,
  connectorId,
  idempotencyHash,
  expiresAt,
}, identity) {
  await requireWrite(projectId, identity);
  const db = await getAdapter();
  let planId;
  db.transaction(() => {
    const duplicate = db.get(
      "SELECT planId FROM chatgptPlanSubmissions WHERE connectorId=? AND idempotencyHash=?",
      [connectorId, idempotencyHash],
    );
    if (duplicate) {
      planId = duplicate.planId;
      return;
    }
    const connector = db.get(
      `SELECT id FROM chatgptConnectors
       WHERE id=? AND projectId=? AND status='ACTIVE' AND allowPlanSubmit=1 AND expiresAt>?`,
      [connectorId, projectId, new Date().toISOString()],
    );
    if (!connector) throw planningError("CONNECTOR_NOT_ACTIVE", "ChatGPT connector cannot submit plans", 403);
    planId = uuidv4();
    const now = new Date().toISOString();
    const requiredQuestions = output.missingInformation.filter((item) => item.required);
    const status = requiredQuestions.length ? "NEEDS_CLARIFICATION" : "OPTIONS_READY";
    db.run(
      `INSERT INTO executionPlans(
        id, projectId, createdBy, apiKeyId, providerId, modelId, status, version, currentRevision,
        originalRequest, interpretedObjective, assumptions, missingInformation, constraints,
        affectedModules, risks, contextTokenEstimate, expiresAt, createdAt, updatedAt
       ) VALUES(?, ?, ?, NULL, 'chatgpt-web-connector', 'interactive-web-session', ?, 2, 1,
        ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        planId, projectId, identity.principalId, status, originalRequest, output.interpretedObjective,
        JSON.stringify(output.assumptions), JSON.stringify(output.missingInformation),
        JSON.stringify(output.constraints), JSON.stringify(output.affectedModules), JSON.stringify(output.risks),
        expiresAt, now, now,
      ],
    );
    db.run(
      `INSERT INTO planRevisions(id, planId, revision, sourceRevision, createdBy, feedback, content, usage, createdAt)
       VALUES(?, ?, 1, NULL, ?, NULL, ?, ?, ?)`,
      [
        uuidv4(), planId, identity.principalId, JSON.stringify(output),
        JSON.stringify({ source: "chatgpt-web-connector", connectorId }), now,
      ],
    );
    output.options.forEach((option, ordinal) => {
      db.run(
        `INSERT INTO planOptions(id, planId, revision, ordinal, name, summary, content, recommended, createdAt)
         VALUES(?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(), planId, ordinal, option.name, option.summary, JSON.stringify(option),
          output.recommendedOptionIndex === ordinal ? 1 : 0, now,
        ],
      );
    });
    db.run(
      `INSERT INTO chatgptPlanSubmissions(id, connectorId, projectId, planId, idempotencyHash, createdAt)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [uuidv4(), connectorId, projectId, planId, idempotencyHash, now],
    );
    audit(db, {
      planId,
      projectId,
      actorId: identity.principalId,
      eventType: "PLAN_CREATED",
      toStatus: "DRAFT",
      planVersion: 1,
      metadata: { source: "chatgpt-web-connector", connectorId },
    });
    audit(db, {
      planId,
      projectId,
      actorId: identity.principalId,
      eventType: "PLAN_DRAFT_SUBMITTED",
      fromStatus: "DRAFT",
      toStatus: status,
      planVersion: 2,
      metadata: { source: "chatgpt-web-connector", connectorId, revision: 1, optionCount: output.options.length },
    });
  });
  return getPlan(projectId, planId, identity);
}

export const __test__ = { parsePlanRow, parseOptionRow, parseRevisionRow, parseApprovalRow };
