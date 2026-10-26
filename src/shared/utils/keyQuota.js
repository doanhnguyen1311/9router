const QUOTA_FIELDS = new Set(["maxCost", "maxInputTokens", "maxRequests"]);

export const KEY_QUOTA_UNLIMITED = Object.freeze({
  maxCost: null,
  maxInputTokens: null,
  maxRequests: null,
});

export const KEY_QUOTA_USAGE_EMPTY = Object.freeze({
  cost: 0,
  inputTokens: 0,
  requests: 0,
  resetAt: null,
});

function nullablePositiveNumber(value, { integer = false } = {}) {
  if (value === null || value === undefined || value === "" || value === 0) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  if (integer && (!Number.isSafeInteger(value) || value < 1)) return undefined;
  if (!integer && value <= 0) return undefined;
  return value;
}

export function validateKeyQuotaInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "quota must be an object" };
  }
  const unknown = Object.keys(input).find((key) => !QUOTA_FIELDS.has(key));
  if (unknown) return { ok: false, error: `quota.${unknown} is not supported` };

  const maxCost = nullablePositiveNumber(input.maxCost);
  if (maxCost === undefined) {
    return { ok: false, error: "quota.maxCost must be a positive number, 0, or null" };
  }
  const maxInputTokens = nullablePositiveNumber(input.maxInputTokens, { integer: true });
  if (maxInputTokens === undefined) {
    return { ok: false, error: "quota.maxInputTokens must be a positive safe integer, 0, or null" };
  }
  const maxRequests = nullablePositiveNumber(input.maxRequests, { integer: true });
  if (maxRequests === undefined) {
    return { ok: false, error: "quota.maxRequests must be a positive safe integer, 0, or null" };
  }

  return { ok: true, value: { maxCost, maxInputTokens, maxRequests } };
}

function positiveColumn(value, { integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (integer && !Number.isSafeInteger(parsed)) return null;
  return parsed;
}

export function keyQuotaFromColumns(maxCost, maxInputTokens, maxRequests) {
  return {
    maxCost: positiveColumn(maxCost),
    maxInputTokens: positiveColumn(maxInputTokens, { integer: true }),
    maxRequests: positiveColumn(maxRequests, { integer: true }),
  };
}

export function keyQuotaToColumns(quota) {
  const checked = validateKeyQuotaInput(quota || KEY_QUOTA_UNLIMITED);
  if (!checked.ok) throw new TypeError(checked.error);
  const value = checked.value;
  return {
    quotaMaxCost: value.maxCost,
    quotaMaxInputTokens: value.maxInputTokens,
    quotaMaxRequests: value.maxRequests,
  };
}

export function keyQuotaUsageFromColumns(cost, inputTokens, requests, resetAt) {
  return {
    cost: Math.max(0, Number(cost) || 0),
    inputTokens: Math.max(0, Number(inputTokens) || 0),
    requests: Math.max(0, Number(requests) || 0),
    resetAt: typeof resetAt === "string" && resetAt ? resetAt : null,
  };
}

export function getExceededKeyQuota(quota, usage) {
  if (quota.maxRequests !== null && usage.requests >= quota.maxRequests) {
    return { kind: "requests", used: usage.requests, limit: quota.maxRequests };
  }
  if (quota.maxInputTokens !== null && usage.inputTokens >= quota.maxInputTokens) {
    return { kind: "input_tokens", used: usage.inputTokens, limit: quota.maxInputTokens };
  }
  if (quota.maxCost !== null && usage.cost >= quota.maxCost) {
    return { kind: "cost", used: usage.cost, limit: quota.maxCost };
  }
  return null;
}
