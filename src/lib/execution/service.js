import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { requireProjectRole } from "@/lib/projectMemory/repository.js";
import { cleanWorkerId, EXECUTION_LIMITS, boundedTimeout, executionError } from "./constants.js";
import {
  cancelExecution,
  claimExecution,
  completeExecution,
  getExecution,
  getExecutionForPlan,
  heartbeatExecution,
  issueExecutionTicket as issueTicketRecord,
  requestExecutionCancellation,
  recoverExpiredExecutions,
} from "./repository.js";
import { normalizeWorkspaceDescriptor } from "./workspace.js";

function requiredVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw executionError("EXECUTION_VERSION_REQUIRED", "A positive expectedVersion is required", 400);
  return value;
}

export function publicExecution(execution) {
  if (!execution) return null;
  const {
    sourceRevision: _sourceRevision,
    ticketHash: _ticketHash,
    ticketId: _ticketId,
    leaseUntil: _leaseUntil,
    heartbeatAt: _heartbeatAt,
    ...safe
  } = execution;
  return safe;
}

export async function issueExecutionTicket(projectId, planId, input, identity) {
  const workerId = cleanWorkerId(input?.workerId);
  const expectedVersion = requiredVersion(input?.expectedVersion);
  const workspace = normalizeWorkspaceDescriptor({ ...(input?.workspace || {}), timeoutMs: input?.timeoutMs });
  const expirationMinutes = Number(input?.expirationMinutes);
  const minutes = Number.isSafeInteger(expirationMinutes) && expirationMinutes >= EXECUTION_LIMITS.ticketExpirationMin && expirationMinutes <= EXECUTION_LIMITS.ticketExpirationMax
    ? expirationMinutes : EXECUTION_LIMITS.defaultTicketExpirationMin;
  const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
  const issued = await issueTicketRecord({ projectId, planId, expectedVersion, workerId, workspace, expiresAt }, identity);
  return { ...issued, execution: publicExecution(issued.execution) };
}

export async function claimExecutionTicket(input, workerId, { validateWorkspace }) {
  return claimExecution({ token: input, workerId, validate: validateWorkspace });
}

export function heartbeatExecutionTicket(input, workerId) {
  return heartbeatExecution({ token: input, workerId }).then(publicExecution);
}

export function completeExecutionTicket(input, workerId, result) {
  return completeExecution({ token: input, workerId, result }).then(publicExecution);
}

export function cancelExecutionTicket(input, workerId, reason) {
  return cancelExecution({ token: input, workerId, reason }).then(publicExecution);
}

export function recoverExecutionLeases() {
  return recoverExpiredExecutions();
}

export function readExecution(projectId, executionId, identity) {
  return getExecution(projectId, executionId, identity).then(publicExecution);
}

export function readExecutionForPlan(projectId, planId, identity) {
  return getExecutionForPlan(projectId, planId, identity).then(publicExecution);
}

export function requestCancellation(projectId, executionId, input, identity) {
  return requestExecutionCancellation({ projectId, executionId, reason: input?.reason }, identity).then(publicExecution);
}

export async function listExecutions(projectId, identity, { limit = 50 } = {}) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor", "viewer"]);
  const db = await getAdapter();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  return db.all("SELECT * FROM planExecutions WHERE projectId=? ORDER BY createdAt DESC LIMIT ?", [projectId, safeLimit])
    .map((row) => publicExecution({
      ...row,
      modifiedFiles: parseJson(row.modifiedFiles, []),
      testResults: parseJson(row.testResults, {}),
      tokenUsage: parseJson(row.tokenUsage, {}),
    }));
}

export const __test__ = { requiredVersion, boundedTimeout };
