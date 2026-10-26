const QUOTA_FIELDS = new Set([
  "maxCost",
  "maxInputTokens",
  "maxRequests",
  "resetMode",
  "resetInterval",
  "resetIntervalValue",
  "resetIntervalUnit",
]);

export const KEY_QUOTA_RESET_MODES = Object.freeze(["manual", "scheduled"]);
export const KEY_QUOTA_RESET_INTERVALS = Object.freeze(["daily", "weekly", "monthly", "custom"]);
export const KEY_QUOTA_RESET_UNITS = Object.freeze(["minutes", "hours", "days"]);

export const KEY_QUOTA_UNLIMITED = Object.freeze({
  maxCost: null,
  maxInputTokens: null,
  maxRequests: null,
  resetMode: "manual",
  resetInterval: null,
  resetIntervalValue: null,
  resetIntervalUnit: null,
});

export const KEY_QUOTA_USAGE_EMPTY = Object.freeze({
  cost: 0,
  inputTokens: 0,
  requests: 0,
  resetAt: null,
  nextResetAt: null,
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

  const resetMode = input.resetMode === undefined ? "manual" : input.resetMode;
  if (!KEY_QUOTA_RESET_MODES.includes(resetMode)) {
    return { ok: false, error: "quota.resetMode must be manual or scheduled" };
  }
  const resetInterval = input.resetInterval === undefined ? null : input.resetInterval;
  if (resetMode === "scheduled" && !KEY_QUOTA_RESET_INTERVALS.includes(resetInterval)) {
    return { ok: false, error: "quota.resetInterval must be daily, weekly, monthly, or custom when resetMode is scheduled" };
  }
  if (resetMode === "manual" && resetInterval !== null) {
    return { ok: false, error: "quota.resetInterval must be null when resetMode is manual" };
  }
  const rawIntervalValue = input.resetIntervalValue;
  const rawIntervalUnit = input.resetIntervalUnit;
  let resetIntervalValue = null;
  let resetIntervalUnit = null;
  if (resetMode === "scheduled" && resetInterval === "custom") {
    if (!Number.isSafeInteger(rawIntervalValue) || rawIntervalValue < 1 || rawIntervalValue > 100000) {
      return { ok: false, error: "quota.resetIntervalValue must be a safe integer between 1 and 100000 for a custom schedule" };
    }
    if (!KEY_QUOTA_RESET_UNITS.includes(rawIntervalUnit)) {
      return { ok: false, error: "quota.resetIntervalUnit must be minutes, hours, or days for a custom schedule" };
    }
    resetIntervalValue = rawIntervalValue;
    resetIntervalUnit = rawIntervalUnit;
  } else if (rawIntervalValue !== undefined && rawIntervalValue !== null) {
    return { ok: false, error: "quota.resetIntervalValue is only supported when resetInterval is custom" };
  } else if (rawIntervalUnit !== undefined && rawIntervalUnit !== null) {
    return { ok: false, error: "quota.resetIntervalUnit is only supported when resetInterval is custom" };
  }

  return {
    ok: true,
    value: {
      maxCost,
      maxInputTokens,
      maxRequests,
      resetMode,
      resetInterval: resetMode === "scheduled" ? resetInterval : null,
      resetIntervalValue,
      resetIntervalUnit,
    },
  };
}

function positiveColumn(value, { integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (integer && !Number.isSafeInteger(parsed)) return null;
  return parsed;
}

export function keyQuotaFromColumns(
  maxCost,
  maxInputTokens,
  maxRequests,
  resetModeCol,
  resetIntervalCol,
  resetIntervalValueCol,
  resetIntervalUnitCol,
) {
  const resetMode = resetModeCol === "scheduled" ? "scheduled" : "manual";
  const resetInterval = KEY_QUOTA_RESET_INTERVALS.includes(resetIntervalCol) ? resetIntervalCol : null;
  const resetIntervalValue = Number(resetIntervalValueCol);
  const validCustom = resetInterval === "custom"
    && Number.isSafeInteger(resetIntervalValue)
    && resetIntervalValue >= 1
    && resetIntervalValue <= 100000
    && KEY_QUOTA_RESET_UNITS.includes(resetIntervalUnitCol);
  const validSchedule = resetMode === "scheduled"
    && resetInterval
    && (resetInterval !== "custom" || validCustom);
  return {
    maxCost: positiveColumn(maxCost),
    maxInputTokens: positiveColumn(maxInputTokens, { integer: true }),
    maxRequests: positiveColumn(maxRequests, { integer: true }),
    resetMode: validSchedule ? "scheduled" : "manual",
    resetInterval: validSchedule ? resetInterval : null,
    resetIntervalValue: validCustom ? resetIntervalValue : null,
    resetIntervalUnit: validCustom ? resetIntervalUnitCol : null,
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
    quotaResetMode: value.resetMode,
    quotaResetInterval: value.resetInterval,
    quotaResetIntervalValue: value.resetIntervalValue,
    quotaResetIntervalUnit: value.resetIntervalUnit,
  };
}

export function keyQuotaUsageFromColumns(cost, inputTokens, requests, resetAt, nextResetAt) {
  return {
    cost: Math.max(0, Number(cost) || 0),
    inputTokens: Math.max(0, Number(inputTokens) || 0),
    requests: Math.max(0, Number(requests) || 0),
    resetAt: typeof resetAt === "string" && resetAt ? resetAt : null,
    nextResetAt: typeof nextResetAt === "string" && nextResetAt ? nextResetAt : null,
  };
}

function validDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function getNextQuotaResetAt(
  interval,
  from = new Date(),
  resetIntervalValue = null,
  resetIntervalUnit = null,
) {
  const date = validDate(from);
  if (!date || !KEY_QUOTA_RESET_INTERVALS.includes(interval)) return null;

  if (interval === "custom") {
    if (!Number.isSafeInteger(resetIntervalValue) || resetIntervalValue < 1 || resetIntervalValue > 100000) return null;
    const unitMs = { minutes: 60000, hours: 3600000, days: 86400000 }[resetIntervalUnit];
    if (!unitMs) return null;
    date.setTime(date.getTime() + resetIntervalValue * unitMs);
  }
  if (interval === "daily") date.setUTCDate(date.getUTCDate() + 1);
  if (interval === "weekly") date.setUTCDate(date.getUTCDate() + 7);
  if (interval === "monthly") {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
    const daysInTargetMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, daysInTargetMonth));
  }
  return date.toISOString();
}

// Resolve a stored schedule without touching persistence. `due` means counters
// must be cleared before quota admission. Advancing from the stored boundary
// preserves cadence even when no requests arrive for several periods.
export function resolveQuotaResetSchedule(quota, storedNextResetAt, now = new Date()) {
  if (quota?.resetMode !== "scheduled" || !KEY_QUOTA_RESET_INTERVALS.includes(quota.resetInterval)) {
    return { due: false, resetAt: null, nextResetAt: null };
  }
  if (quota.resetInterval === "custom" && (
    !Number.isSafeInteger(quota.resetIntervalValue)
    || quota.resetIntervalValue < 1
    || quota.resetIntervalValue > 100000
    || !KEY_QUOTA_RESET_UNITS.includes(quota.resetIntervalUnit)
  )) {
    return { due: false, resetAt: null, nextResetAt: null };
  }

  const nowDate = validDate(now) || new Date();
  let next = validDate(storedNextResetAt);
  if (!next) {
    return {
      due: false,
      resetAt: null,
      nextResetAt: getNextQuotaResetAt(
        quota.resetInterval,
        nowDate,
        quota.resetIntervalValue,
        quota.resetIntervalUnit,
      ),
    };
  }
  if (next.getTime() > nowDate.getTime()) {
    return { due: false, resetAt: null, nextResetAt: next.toISOString() };
  }

  let lastBoundary = next;
  if (quota.resetInterval === "daily" || quota.resetInterval === "weekly" || quota.resetInterval === "custom") {
    const customUnitMs = { minutes: 60000, hours: 3600000, days: 86400000 }[quota.resetIntervalUnit];
    const stepMs = quota.resetInterval === "daily"
      ? 86400000
      : quota.resetInterval === "weekly"
        ? 7 * 86400000
        : quota.resetIntervalValue * customUnitMs;
    const elapsedSteps = Math.floor((nowDate.getTime() - next.getTime()) / stepMs);
    lastBoundary = new Date(next.getTime() + elapsedSteps * stepMs);
    next = new Date(lastBoundary.getTime() + stepMs);
  } else {
    // 1200 months is a corruption guard, not a normal operational limit.
    for (let i = 0; i < 1200 && next.getTime() <= nowDate.getTime(); i += 1) {
      lastBoundary = next;
      next = validDate(getNextQuotaResetAt("monthly", next));
    }
    if (!next || next.getTime() <= nowDate.getTime()) {
      lastBoundary = nowDate;
      next = validDate(getNextQuotaResetAt("monthly", nowDate));
    }
  }

  return {
    due: true,
    resetAt: lastBoundary.toISOString(),
    nextResetAt: next.toISOString(),
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
