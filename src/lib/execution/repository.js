import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { upsertMemoryInTransaction } from "@/lib/projectMemory/memoryRepository.js";
import { redactProjectText } from "@/lib/projectMemory/privacy.js";
import { requireProjectRole } from "@/lib/projectMemory/repository.js";
import { executionError } from "./constants.js";
import { hashTicket, randomTicketNonce, signExecutionTicket, verifyExecutionTicket } from "./ticket.js";

function parseExecution(row) {
  if (!row) return null;
  return {
    ...row,
    sourceRevision: parseJson(row.sourceRevision, {}),
    modifiedFiles: parseJson(row.modifiedFiles, []),
    testResults: parseJson(row.testResults, {}),
    tokenUsage: parseJson(row.tokenUsage, {}),
  };
}

function executionPlan(db, row) {
  if (!row) return null;
  const plan = {
    ...row,
    assumptions: parseJson(row.assumptions, []),
    missingInformation: parseJson(row.missingInformation, []),
    constraints: parseJson(row.constraints, []),
    affectedModules: parseJson(row.affectedModules, []),
    risks: parseJson(row.risks, []),
    options: [],
  };
  plan.options = db.all("SELECT * FROM planOptions WHERE planId=? AND revision=? ORDER BY ordinal", [row.id, row.currentRevision]).map((option) => ({
    ...parseJson(option.content, {}), id: option.id, ordinal: option.ordinal, recommended: option.recommended === 1,
  }));
  return plan;
}

function audit(db, { planId, projectId, actorId, eventType, fromStatus = null, toStatus = null, planVersion, metadata = {} }) {
  db.run(
    `INSERT INTO planAuditLogs(id, planId, projectId, actorId, eventType, fromStatus, toStatus, planVersion, metadata, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), planId, projectId, actorId, eventType, fromStatus, toStatus, planVersion, JSON.stringify(metadata), new Date().toISOString()],
  );
}

function redactedText(value, maxChars) {
  return redactProjectText(String(value || "").slice(0, maxChars)).text.slice(0, maxChars);
}

function resultFiles(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === "string").map((entry) => entry.replaceAll("\\", "/").trim()).filter((entry) => (
    entry && entry.length <= 1_000 && !entry.startsWith("/") && !entry.split("/").includes("..") && !entry.includes("\u0000")
  )))].slice(0, 500);
}

function boundedJson(value, maxChars) {
  const raw = JSON.stringify(value ?? {});
  return raw.length <= maxChars ? raw : JSON.stringify({ truncated: true });
}

export async function issueExecutionTicket({
  projectId,
  planId,
  expectedVersion,
  workerId,
  workspace,
  expiresAt,
}, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const db = await getAdapter();
  const ticketId = uuidv4();
  const executionId = uuidv4();
  const nonce = randomTicketNonce();
  const now = new Date().toISOString();
  const payload = {
    ticketId, executionId, planId, projectId, workerId,
    scope: "EXECUTE_APPROVED_PLAN",
    approvedRevision: null,
    approvedPlanVersion: expectedVersion,
    nonce,
    exp: Date.parse(expiresAt),
  };
  let token;
  let execution;
  db.transaction(() => {
    const plan = db.get("SELECT * FROM executionPlans WHERE id=? AND projectId=?", [planId, projectId]);
    if (!plan) throw executionError("PLAN_NOT_FOUND", "Plan not found", 404);
    if (plan.version !== expectedVersion) throw executionError("PLAN_VERSION_CONFLICT", "Approved plan version is stale", 409, { currentVersion: plan.version });
    if (plan.status !== "APPROVED") throw executionError("PLAN_NOT_APPROVED", "Only an approved plan can receive an execution ticket", 409);
    const approval = db.get("SELECT * FROM planApprovals WHERE planId=? AND decision='APPROVED'", [planId]);
    if (!approval || approval.revision !== plan.currentRevision || approval.optionId !== plan.selectedOptionId) {
      throw executionError("PLAN_APPROVAL_MISSING", "The approved revision or option is unavailable", 409);
    }
    if (db.get("SELECT id FROM planExecutions WHERE planId=?", [planId])) throw executionError("EXECUTION_DUPLICATE", "This approved plan already has an execution", 409);
    payload.approvedRevision = plan.currentRevision;
  });
  token = await signExecutionTicket(payload);
  db.transaction(() => {
    const plan = db.get("SELECT * FROM executionPlans WHERE id=? AND projectId=?", [planId, projectId]);
    if (!plan || plan.version !== expectedVersion || plan.status !== "APPROVED") throw executionError("PLAN_VERSION_CONFLICT", "Approved plan changed while issuing ticket", 409);
    db.run(
      `INSERT INTO planExecutions(
        id, planId, projectId, ticketId, workerId, status, approvedRevision, approvedPlanVersion,
        sourceRevision, ticketHash, createdAt, updatedAt
       ) VALUES(?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?)`,
      [executionId, planId, projectId, ticketId, workerId, payload.approvedRevision, expectedVersion, JSON.stringify(workspace), hashTicket(token), now, now],
    );
    audit(db, {
      planId, projectId, actorId: identity.principalId, eventType: "EXECUTION_TICKET_ISSUED",
      fromStatus: "APPROVED", toStatus: "APPROVED", planVersion: expectedVersion,
      metadata: { executionId, ticketId, workerId, approvedRevision: payload.approvedRevision },
    });
    execution = parseExecution(db.get("SELECT * FROM planExecutions WHERE id=?", [executionId]));
  });
  return { execution, ticket: token, expiresAt };
}

async function loadTicketRecord(token) {
  const claims = await verifyExecutionTicket(token);
  const db = await getAdapter();
  const row = db.get("SELECT * FROM planExecutions WHERE id=? AND ticketId=? AND ticketHash=?", [claims.executionId, claims.ticketId, hashTicket(token)]);
  if (!row) throw executionError("EXECUTION_TICKET_UNKNOWN", "Execution ticket is unknown or revoked", 401);
  if (row.workerId !== claims.workerId) throw executionError("EXECUTION_TICKET_WORKER_MISMATCH", "Execution ticket is bound to another worker", 403);
  return { claims, row: parseExecution(row) };
}

export async function claimExecution({ token, workerId, validate }) {
  const { claims } = await loadTicketRecord(token);
  if (claims.workerId !== workerId) throw executionError("EXECUTION_TICKET_WORKER_MISMATCH", "Execution ticket is bound to another worker", 403);
  const db = await getAdapter();
  let result;
  let staleApproval = false;
  db.transaction(() => {
    const current = db.get("SELECT * FROM planExecutions WHERE id=? AND ticketId=?", [claims.executionId, claims.ticketId]);
    if (!current) throw executionError("EXECUTION_NOT_FOUND", "Execution not found", 404);
    if (current.status !== "QUEUED") throw executionError("EXECUTION_STATE_CONFLICT", `Execution cannot be claimed from ${current.status}`, 409);
    const plan = db.get("SELECT * FROM executionPlans WHERE id=? AND projectId=?", [claims.planId, claims.projectId]);
    if (!plan || plan.status !== "APPROVED" || plan.version !== claims.approvedPlanVersion || plan.currentRevision !== claims.approvedRevision) {
      db.run("UPDATE planExecutions SET status='STALE', errorCode='STALE_APPROVAL', errorMessage=?, updatedAt=? WHERE id=? AND status='QUEUED'", ["Approved plan changed before execution", new Date().toISOString(), claims.executionId]);
      if (plan?.status === "APPROVED") {
        const now = new Date().toISOString();
        db.run("UPDATE executionPlans SET status='STALE', version=version+1, updatedAt=? WHERE id=? AND status='APPROVED'", [now, claims.planId]);
        audit(db, { planId: claims.planId, projectId: claims.projectId, actorId: workerId, eventType: "EXECUTION_MARKED_STALE", fromStatus: "APPROVED", toStatus: "STALE", planVersion: plan.version + 1, metadata: { executionId: claims.executionId, reason: "approved plan changed" } });
      }
      staleApproval = true;
      return;
    }
    result = { current: parseExecution(current), plan: executionPlan(db, plan) };
  });
  if (staleApproval) throw executionError("EXECUTION_STALE", "Approved plan is stale and must be re-approved", 409);
  const workspace = await validate(result.current.sourceRevision);
  if (workspace.stale) {
    db.transaction(() => {
      db.run("UPDATE planExecutions SET status='STALE', errorCode='STALE_WORKSPACE', errorMessage=?, updatedAt=? WHERE id=? AND status='QUEUED'", [workspace.staleReasons.join("; "), new Date().toISOString(), claims.executionId]);
      const plan = db.get("SELECT * FROM executionPlans WHERE id=?", [claims.planId]);
      if (plan?.status === "APPROVED") {
        db.run("UPDATE executionPlans SET status='STALE', version=version+1, updatedAt=? WHERE id=? AND status='APPROVED'", [new Date().toISOString(), claims.planId]);
        audit(db, { planId: claims.planId, projectId: claims.projectId, actorId: workerId, eventType: "EXECUTION_MARKED_STALE", fromStatus: "APPROVED", toStatus: "STALE", planVersion: plan.version + 1, metadata: { reasons: workspace.staleReasons } });
      }
    });
    throw executionError("EXECUTION_STALE", "Workspace changed since approval", 409, { reasons: workspace.staleReasons });
  }
  db.transaction(() => {
    const now = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + 60_000).toISOString();
    const plan = db.get("SELECT * FROM executionPlans WHERE id=?", [claims.planId]);
    const updatedExecution = db.run("UPDATE planExecutions SET status='EXECUTING', leaseUntil=?, heartbeatAt=?, startedAt=?, updatedAt=? WHERE id=? AND status='QUEUED'", [leaseUntil, now, now, now, claims.executionId])?.changes || 0;
    const updatedPlan = db.run("UPDATE executionPlans SET status='EXECUTING', version=version+1, updatedAt=? WHERE id=? AND status='APPROVED' AND version=?", [now, claims.planId, claims.approvedPlanVersion])?.changes || 0;
    if (updatedExecution !== 1 || updatedPlan !== 1) throw executionError("EXECUTION_STATE_CONFLICT", "Execution was claimed by another worker", 409);
    audit(db, { planId: claims.planId, projectId: claims.projectId, actorId: workerId, eventType: "EXECUTION_STARTED", fromStatus: "APPROVED", toStatus: "EXECUTING", planVersion: plan.version + 1, metadata: { executionId: claims.executionId } });
  });
  const finalDb = await getAdapter();
  return { claims, execution: parseExecution(finalDb.get("SELECT * FROM planExecutions WHERE id=?", [claims.executionId])), plan: executionPlan(finalDb, finalDb.get("SELECT * FROM executionPlans WHERE id=?", [claims.planId])) };
}

export async function heartbeatExecution({ token, workerId }) {
  const { claims } = await loadTicketRecord(token);
  if (claims.workerId !== workerId) throw executionError("EXECUTION_TICKET_WORKER_MISMATCH", "Execution ticket is bound to another worker", 403);
  const db = await getAdapter();
  const now = new Date().toISOString();
  const changed = db.run("UPDATE planExecutions SET heartbeatAt=?, leaseUntil=?, updatedAt=? WHERE id=? AND workerId=? AND status='EXECUTING'", [now, new Date(Date.now() + 60_000).toISOString(), now, claims.executionId, workerId])?.changes || 0;
  if (!changed) throw executionError("EXECUTION_STATE_CONFLICT", "Execution is no longer active", 409);
  return parseExecution(db.get("SELECT * FROM planExecutions WHERE id=?", [claims.executionId]));
}

export async function completeExecution({ token, workerId, result }) {
  const { claims } = await loadTicketRecord(token);
  if (claims.workerId !== workerId) throw executionError("EXECUTION_TICKET_WORKER_MISMATCH", "Execution ticket is bound to another worker", 403);
  const db = await getAdapter();
  let execution;
  const success = Number(result?.exitStatus) === 0 && result?.cancelled !== true;
  const sanitized = {
    modifiedFiles: resultFiles(result?.modifiedFiles),
    diffSummary: redactedText(result?.diffSummary, 20_000),
    testResults: boundedJson(result?.testResults, 40_000),
    filteredLogs: redactedText(result?.filteredLogs, 120_000),
    tokenUsage: boundedJson(result?.tokenUsage, 10_000),
    errorCode: result?.errorCode == null ? null : redactedText(result.errorCode, 200),
    errorMessage: result?.errorMessage == null ? null : redactedText(result.errorMessage, 2_000),
  };
  db.transaction(() => {
    const current = db.get("SELECT * FROM planExecutions WHERE id=? AND status='EXECUTING'", [claims.executionId]);
    if (!current) throw executionError("EXECUTION_STATE_CONFLICT", "Execution is no longer active", 409);
    const plan = db.get("SELECT * FROM executionPlans WHERE id=?", [claims.planId]);
    const now = new Date().toISOString();
    const nextStatus = success ? "COMPLETED" : (result?.cancelled ? "CANCELLED" : "FAILED");
    const planStatus = nextStatus === "COMPLETED" ? "COMPLETED" : nextStatus;
    db.run(
      `UPDATE planExecutions SET status=?, exitStatus=?, modifiedFiles=?, diffSummary=?, testResults=?, filteredLogs=?, tokenUsage=?, errorCode=?, errorMessage=?, durationMs=?, completedAt=?, leaseUntil=NULL, updatedAt=? WHERE id=? AND status='EXECUTING'`,
      [nextStatus, Number.isInteger(result?.exitStatus) ? result.exitStatus : null, JSON.stringify(sanitized.modifiedFiles), sanitized.diffSummary, sanitized.testResults, sanitized.filteredLogs, sanitized.tokenUsage, sanitized.errorCode || (success ? null : "CODEX_EXECUTION_FAILED"), sanitized.errorMessage || (success ? null : "Codex execution failed"), Number(result?.durationMs) || null, now, now, claims.executionId],
    );
    const planChanged = db.run("UPDATE executionPlans SET status=?, version=version+1, updatedAt=? WHERE id=? AND status='EXECUTING'", [planStatus, now, claims.planId])?.changes || 0;
    if (planChanged !== 1) throw executionError("EXECUTION_STATE_CONFLICT", "Plan state changed during completion", 409);
    audit(db, { planId: claims.planId, projectId: claims.projectId, actorId: workerId, eventType: success ? "EXECUTION_COMPLETED" : nextStatus === "CANCELLED" ? "EXECUTION_CANCELLED" : "EXECUTION_FAILED", fromStatus: "EXECUTING", toStatus: planStatus, planVersion: plan.version + 1, metadata: { executionId: claims.executionId, exitStatus: result?.exitStatus } });
    execution = parseExecution(db.get("SELECT * FROM planExecutions WHERE id=?", [claims.executionId]));
    if (success) {
      upsertMemoryInTransaction(db, {
        projectId: claims.projectId,
        memoryType: "resolution",
        subject: `Verified execution ${claims.executionId}`,
        value: `Codex completed the approved plan with exit status 0. Modified files: ${sanitized.modifiedFiles.join(", ") || "none"}.`,
        structuredContent: { executionId: claims.executionId, planId: claims.planId, modifiedFiles: sanitized.modifiedFiles, exitStatus: result?.exitStatus },
        confidence: 0.95,
        sourceType: "tool-verified",
        evidenceReference: `execution:${claims.executionId}`,
      });
    }
  });
  return execution;
}

export async function cancelExecution({ token, workerId, reason = "Cancelled by worker" }) {
  const { claims } = await loadTicketRecord(token);
  if (claims.workerId !== workerId) throw executionError("EXECUTION_TICKET_WORKER_MISMATCH", "Execution ticket is bound to another worker", 403);
  const db = await getAdapter();
  let execution;
  db.transaction(() => {
    const current = db.get("SELECT * FROM planExecutions WHERE id=? AND status IN ('QUEUED','EXECUTING')", [claims.executionId]);
    if (!current) throw executionError("EXECUTION_STATE_CONFLICT", "Execution is no longer cancellable", 409);
    const now = new Date().toISOString();
    db.run("UPDATE planExecutions SET status='CANCELLED', cancelRequestedAt=?, errorCode='EXECUTION_CANCELLED', errorMessage=?, leaseUntil=NULL, updatedAt=? WHERE id=? AND status IN ('QUEUED','EXECUTING')", [now, String(reason).slice(0, 500), now, claims.executionId]);
    const plan = db.get("SELECT * FROM executionPlans WHERE id=?", [claims.planId]);
    db.run("UPDATE executionPlans SET status='CANCELLED', version=version+1, updatedAt=? WHERE id=? AND status IN ('APPROVED','EXECUTING')", [now, claims.planId]);
    audit(db, { planId: claims.planId, projectId: claims.projectId, actorId: workerId, eventType: "EXECUTION_CANCELLED", fromStatus: plan.status, toStatus: "CANCELLED", planVersion: plan.version + 1, metadata: { executionId: claims.executionId, reason } });
    execution = parseExecution(db.get("SELECT * FROM planExecutions WHERE id=?", [claims.executionId]));
  });
  return execution;
}

export async function requestExecutionCancellation({ projectId, executionId, reason = "Cancelled by user" }, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const db = await getAdapter();
  let execution;
  db.transaction(() => {
    const current = db.get("SELECT * FROM planExecutions WHERE id=? AND projectId=?", [executionId, projectId]);
    if (!current) throw executionError("EXECUTION_NOT_FOUND", "Execution not found", 404);
    if (!['QUEUED', 'EXECUTING'].includes(current.status)) {
      throw executionError("EXECUTION_STATE_CONFLICT", `Execution cannot be cancelled from ${current.status}`, 409);
    }
    const now = new Date().toISOString();
    const cleanReason = String(reason || "Cancelled by user").slice(0, 500);
    if (current.status === "QUEUED") {
      db.run("UPDATE planExecutions SET status='CANCELLED', cancelRequestedAt=?, errorCode='EXECUTION_CANCELLED', errorMessage=?, completedAt=?, updatedAt=? WHERE id=? AND status='QUEUED'", [now, cleanReason, now, now, executionId]);
      db.run("UPDATE executionPlans SET status='CANCELLED', version=version+1, updatedAt=? WHERE id=? AND status='APPROVED'", [now, current.planId]);
    } else {
      db.run("UPDATE planExecutions SET cancelRequestedAt=?, errorMessage=?, updatedAt=? WHERE id=? AND status='EXECUTING'", [now, cleanReason, now, executionId]);
    }
    const plan = db.get("SELECT * FROM executionPlans WHERE id=?", [current.planId]);
    audit(db, {
      planId: current.planId,
      projectId,
      actorId: identity.principalId,
      eventType: current.status === "QUEUED" ? "EXECUTION_CANCELLED" : "EXECUTION_CANCELLATION_REQUESTED",
      fromStatus: current.status === "QUEUED" ? "APPROVED" : "EXECUTING",
      toStatus: current.status === "QUEUED" ? "CANCELLED" : "EXECUTING",
      planVersion: plan.version,
      metadata: { executionId, reason: cleanReason },
    });
    execution = parseExecution(db.get("SELECT * FROM planExecutions WHERE id=?", [executionId]));
  });
  return execution;
}

export async function recoverExpiredExecutions() {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let recovered = 0;
  db.transaction(() => {
    const rows = db.all("SELECT * FROM planExecutions WHERE status='EXECUTING' AND leaseUntil IS NOT NULL AND leaseUntil<=?", [now]);
    for (const row of rows) {
      const changed = db.run("UPDATE planExecutions SET status='FAILED', errorCode='WORKER_LEASE_EXPIRED', errorMessage='Worker lease expired; no automatic retry was performed', leaseUntil=NULL, completedAt=?, updatedAt=? WHERE id=? AND status='EXECUTING'", [now, now, row.id])?.changes || 0;
      if (!changed) continue;
      const plan = db.get("SELECT * FROM executionPlans WHERE id=?", [row.planId]);
      if (plan?.status === "EXECUTING") {
        db.run("UPDATE executionPlans SET status='FAILED', version=version+1, updatedAt=? WHERE id=? AND status='EXECUTING'", [now, row.planId]);
        audit(db, { planId: row.planId, projectId: row.projectId, actorId: "system", eventType: "EXECUTION_LEASE_EXPIRED", fromStatus: "EXECUTING", toStatus: "FAILED", planVersion: plan.version + 1, metadata: { executionId: row.id } });
      }
      recovered += 1;
    }
  });
  return recovered;
}

export async function getExecution(projectId, executionId, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor", "viewer"]);
  const db = await getAdapter();
  const execution = parseExecution(db.get("SELECT * FROM planExecutions WHERE id=? AND projectId=?", [executionId, projectId]));
  if (!execution) throw executionError("EXECUTION_NOT_FOUND", "Execution not found", 404);
  return execution;
}

export const __test__ = { parseExecution, executionPlan };
