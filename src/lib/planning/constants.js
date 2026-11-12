export const PLAN_STATUSES = Object.freeze([
  "DRAFT",
  "NEEDS_CLARIFICATION",
  "OPTIONS_READY",
  "PENDING_APPROVAL",
  "APPROVED",
  "EXECUTING",
  "COMPLETED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "STALE",
  "EXPIRED",
]);

export const PHASE_ONE_MUTABLE_STATUSES = Object.freeze([
  "DRAFT",
  "NEEDS_CLARIFICATION",
  "OPTIONS_READY",
  "PENDING_APPROVAL",
]);

export const TERMINAL_PLAN_STATUSES = Object.freeze([
  "COMPLETED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
]);

export const PLAN_LIMITS = Object.freeze({
  originalRequestChars: 20_000,
  feedbackChars: 12_000,
  providerIdChars: 120,
  modelIdChars: 240,
  responseChars: 1_000_000,
  contextTokensMin: 256,
  contextTokensMax: 16_000,
  defaultContextTokens: 1_800,
  timeoutMsMin: 5_000,
  timeoutMsMax: 300_000,
  defaultTimeoutMs: 120_000,
  expirationMinutesMin: 5,
  expirationMinutesMax: 60 * 24 * 30,
  defaultExpirationMinutes: 60 * 24 * 7,
  maxOptions: 5,
});

export function planningError(code, message, status = 400, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

export function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
