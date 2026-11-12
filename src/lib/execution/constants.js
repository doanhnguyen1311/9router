export const EXECUTION_LIMITS = Object.freeze({
  workerIdChars: 160,
  ticketChars: 8_000,
  workspaceRootChars: 2_000,
  maxFiles: 500,
  maxFilePathChars: 1_000,
  maxLogsChars: 120_000,
  maxErrorChars: 2_000,
  leaseMs: 60_000,
  heartbeatMs: 15_000,
  timeoutMsMin: 10_000,
  timeoutMsMax: 86_400_000,
  defaultTimeoutMs: 30 * 60_000,
  ticketExpirationMin: 1,
  ticketExpirationMax: 60,
  defaultTicketExpirationMin: 15,
});

export function executionError(code, message, status = 400, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

export function cleanWorkerId(value) {
  if (typeof value !== "string") throw executionError("WORKER_ID_INVALID", "workerId is required", 400);
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!clean || clean.length > EXECUTION_LIMITS.workerIdChars) throw executionError("WORKER_ID_INVALID", "workerId is invalid", 400);
  return clean;
}

export function boundedTimeout(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= EXECUTION_LIMITS.timeoutMsMin && parsed <= EXECUTION_LIMITS.timeoutMsMax
    ? parsed : EXECUTION_LIMITS.defaultTimeoutMs;
}
