import { v4 as uuidv4 } from "uuid";
import { KEY_EFFORT_DEFAULT, keyEffortFromColumn, validateKeyEffortPolicy, KEY_EFFORT_VALUES } from "@/shared/utils/keyEffort.js";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";
import {
  KEY_MODEL_ROUTING_DISABLED,
  keyModelRoutingFromColumns,
  keyModelRoutingToColumns,
  reconcileKeyModelRouting,
  validateKeyModelRoutingInput,
} from "@/shared/utils/keyModelRouting.js";
import { notifyApiKeysChanged } from "@/lib/apiKeyEvents.js";
import {
  KEY_QUOTA_UNLIMITED,
  getExceededKeyQuota,
  getNextQuotaResetAt,
  isKeyQuotaExpired,
  keyQuotaFromColumns,
  keyQuotaToColumns,
  keyQuotaUsageFromColumns,
  resolveQuotaResetSchedule,
} from "@/shared/utils/keyQuota.js";

function quotaFromRow(row) {
  return keyQuotaFromColumns(
    row.quotaMaxCost,
    row.quotaMaxInputTokens,
    row.quotaMaxRequests,
    row.quotaResetMode,
    row.quotaResetInterval,
    row.quotaResetIntervalValue,
    row.quotaResetIntervalUnit,
    row.quotaExpiresAt,
  );
}

function rowToKey(row) {
  if (!row) return null;
  const quota = quotaFromRow(row);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    access: keyAccessFromColumns(
      row.accessRestricted,
      row.accessAllow,
      row.accessAccountRestricted,
      row.accessAccountIds,
    ),
    modelRouting: keyModelRoutingFromColumns(row.modelAlias, row.selectedModel),
    effortPolicy: keyEffortFromColumn(row.effortPolicy),
    quota,
    isExpired: isKeyQuotaExpired(quota),
    usage: keyQuotaUsageFromColumns(
      row.quotaUsedCost,
      row.quotaUsedInputTokens,
      row.quotaUsedRequests,
      row.quotaUsageResetAt,
      row.quotaNextResetAt,
    ),
  };
}

// Must be called inside a transaction. It lazily creates/advances a schedule
// and clears counters before the current row is used for quota admission.
function applyDueQuotaReset(db, row, now = new Date()) {
  if (!row) return { row, changed: false };
  const quota = quotaFromRow(row);
  const schedule = resolveQuotaResetSchedule(quota, row.quotaNextResetAt, now);
  const currentNext = typeof row.quotaNextResetAt === "string" && row.quotaNextResetAt
    ? row.quotaNextResetAt
    : null;

  if (!schedule.due && schedule.nextResetAt === currentNext) {
    return { row, changed: false };
  }

  if (schedule.due) {
    db.run(
      `UPDATE apiKeys SET
        quotaUsedCost = 0,
        quotaUsedInputTokens = 0,
        quotaUsedRequests = 0,
        quotaUsageResetAt = ?,
        quotaNextResetAt = ?
       WHERE id = ?`,
      [schedule.resetAt, schedule.nextResetAt, row.id],
    );
  } else {
    db.run(`UPDATE apiKeys SET quotaNextResetAt = ? WHERE id = ?`, [schedule.nextResetAt, row.id]);
  }

  return {
    row: db.get(`SELECT * FROM apiKeys WHERE id = ?`, [row.id]),
    changed: true,
  };
}

// Called by usageRepo inside the same transaction as the usage-history write.
// If a response finishes after a scheduled boundary, its token/cost usage is
// charged to the new window rather than resurrecting counters from the old one.
export function recordApiKeyTokenCost(db, key, inputTokens, cost, now = new Date()) {
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  const applied = applyDueQuotaReset(db, row, now);
  db.run(
    `UPDATE apiKeys SET
      quotaUsedInputTokens = COALESCE(quotaUsedInputTokens, 0) + ?,
      quotaUsedCost = COALESCE(quotaUsedCost, 0) + ?
     WHERE id = ?`,
    [Math.max(0, Number(inputTokens) || 0), Math.max(0, Number(cost) || 0), applied.row.id],
  );
  return true;
}

export async function getApiKeys() {
  const db = await getAdapter();
  let rows = [];
  let changed = false;
  db.transaction(() => {
    rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`).map((row) => {
      const applied = applyDueQuotaReset(db, row);
      changed = changed || applied.changed;
      return applied.row;
    });
  });
  if (changed) notifyApiKeysChanged();
  return rows.map(rowToKey);
}

// Display metadata for one authorized History page. Never load credentials or
// touch quota/reset state just to resolve the request owner's name.
export async function getApiKeyNamesByIds(ids) {
  const unique = [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 256))].slice(0, 50);
  if (!unique.length) return [];
  const db = await getAdapter();
  return db.all(`SELECT id, substr(name, 1, 200) AS name FROM apiKeys WHERE id IN (${unique.map(() => '?').join(',')})`, unique);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  let row = null;
  let changed = false;
  db.transaction(() => {
    const applied = applyDueQuotaReset(db, db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
    row = applied.row;
    changed = applied.changed;
  });
  if (changed) notifyApiKeysChanged();
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  let row = null;
  let changed = false;
  db.transaction(() => {
    const applied = applyDueQuotaReset(db, db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]));
    row = applied.row;
    changed = applied.changed;
  });
  if (changed) notifyApiKeysChanged();
  return rowToKey(row);
}

export async function createApiKey(name, machineId, quota = KEY_QUOTA_UNLIMITED) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const quotaCols = keyQuotaToColumns(quota);
  const normalizedQuota = keyQuotaFromColumns(
    quotaCols.quotaMaxCost,
    quotaCols.quotaMaxInputTokens,
    quotaCols.quotaMaxRequests,
    quotaCols.quotaResetMode,
    quotaCols.quotaResetInterval,
    quotaCols.quotaResetIntervalValue,
    quotaCols.quotaResetIntervalUnit,
    quotaCols.quotaExpiresAt,
  );
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    access: { restricted: false, allow: [], accountRestricted: false, accountIds: [] },
    modelRouting: { ...KEY_MODEL_ROUTING_DISABLED },
    effortPolicy: { ...KEY_EFFORT_DEFAULT, overrides: [] },
    quota: normalizedQuota,
    isExpired: isKeyQuotaExpired(normalizedQuota),
    usage: {
      cost: 0,
      inputTokens: 0,
      requests: 0,
      resetAt: null,
      nextResetAt: normalizedQuota.resetMode === "scheduled"
        ? getNextQuotaResetAt(
          normalizedQuota.resetInterval,
          new Date(),
          normalizedQuota.resetIntervalValue,
          normalizedQuota.resetIntervalUnit,
        )
        : null,
    },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  db.run(
    `INSERT INTO apiKeys(
      id, key, name, machineId, isActive, createdAt,
      accessRestricted, accessAllow, accessAccountRestricted, accessAccountIds,
      modelAlias, selectedModel,
      quotaMaxCost, quotaMaxInputTokens, quotaMaxRequests,
      quotaResetMode, quotaResetInterval, quotaResetIntervalValue, quotaResetIntervalUnit, quotaExpiresAt, quotaNextResetAt,
      quotaUsedCost, quotaUsedInputTokens, quotaUsedRequests
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
    [
      apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt,
      cols.accessRestricted, cols.accessAllow, cols.accessAccountRestricted, cols.accessAccountIds,
      null, null,
      quotaCols.quotaMaxCost, quotaCols.quotaMaxInputTokens, quotaCols.quotaMaxRequests,
      quotaCols.quotaResetMode, quotaCols.quotaResetInterval,
      quotaCols.quotaResetIntervalValue, quotaCols.quotaResetIntervalUnit,
      quotaCols.quotaExpiresAt,
      apiKey.usage.nextResetAt,
    ]
  );
  notifyApiKeysChanged();
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const current = rowToKey(row);
    const nextQuota = data.quota ? { ...current.quota, ...data.quota } : current.quota;
    const merged = { ...current, ...data, quota: nextQuota };
    if (data.selectedEffort !== undefined) {
      if (!current.effortPolicy.allowUserChoice || current.effortPolicy.invalid) {
        const error = new Error("Effort is controlled by the administrator"); error.code = "KEY_EFFORT_FORBIDDEN"; throw error;
      }
      if (data.selectedEffort !== null && !KEY_EFFORT_VALUES.includes(data.selectedEffort)) {
        const error = new Error("Invalid effort level"); error.code = "INVALID_KEY_EFFORT"; throw error;
      }
      merged.effortPolicy = { ...current.effortPolicy, effort: data.selectedEffort };
    } else if (data.effortPolicy !== undefined) {
      const checked = validateKeyEffortPolicy(data.effortPolicy);
      if (!checked.ok) { const error = new Error(checked.error); error.code = "INVALID_KEY_EFFORT"; throw error; }
      merged.effortPolicy = checked.value;
    }
    if (data.modelRouting !== undefined) {
      const checked = validateKeyModelRoutingInput(data.modelRouting, merged.access);
      if (!checked.ok) {
        const error = new Error(checked.error);
        error.code = "INVALID_KEY_MODEL_ROUTING";
        throw error;
      }
      merged.modelRouting = checked.value;
    } else {
      merged.modelRouting = reconcileKeyModelRouting(current.modelRouting, merged.access);
    }
    if (merged.modelRouting.alias) {
      const duplicate = db.get(
        `SELECT id FROM apiKeys WHERE id <> ? AND modelAlias = ? COLLATE NOCASE LIMIT 1`,
        [id, merged.modelRouting.alias],
      );
      if (duplicate) {
        const error = new Error("Public model name is already used by another API key");
        error.code = "KEY_MODEL_ALIAS_CONFLICT";
        throw error;
      }
    }
    const cols = keyAccessToColumns(merged.access);
    const routingCols = keyModelRoutingToColumns(merged.modelRouting);
    const quotaCols = keyQuotaToColumns(merged.quota);
    const scheduleChanged = current.quota.resetMode !== merged.quota.resetMode
      || current.quota.resetInterval !== merged.quota.resetInterval
      || current.quota.resetIntervalValue !== merged.quota.resetIntervalValue
      || current.quota.resetIntervalUnit !== merged.quota.resetIntervalUnit;
    const nextResetAt = merged.quota.resetMode === "scheduled"
      ? (scheduleChanged
        ? getNextQuotaResetAt(
          merged.quota.resetInterval,
          new Date(),
          merged.quota.resetIntervalValue,
          merged.quota.resetIntervalUnit,
        )
        : current.usage.nextResetAt)
      : null;
    db.run(
      `UPDATE apiKeys SET
        key = ?, name = ?, machineId = ?, isActive = ?,
        accessRestricted = ?, accessAllow = ?, accessAccountRestricted = ?, accessAccountIds = ?,
        modelAlias = ?, selectedModel = ?, effortPolicy = ?,
        quotaMaxCost = ?, quotaMaxInputTokens = ?, quotaMaxRequests = ?,
        quotaResetMode = ?, quotaResetInterval = ?,
        quotaResetIntervalValue = ?, quotaResetIntervalUnit = ?, quotaExpiresAt = ?, quotaNextResetAt = ?
       WHERE id = ?`,
      [
        merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0,
        cols.accessRestricted, cols.accessAllow, cols.accessAccountRestricted, cols.accessAccountIds,
        routingCols.modelAlias, routingCols.selectedModel,
        JSON.stringify(merged.effortPolicy),
        quotaCols.quotaMaxCost, quotaCols.quotaMaxInputTokens, quotaCols.quotaMaxRequests,
        quotaCols.quotaResetMode, quotaCols.quotaResetInterval,
        quotaCols.quotaResetIntervalValue, quotaCols.quotaResetIntervalUnit,
        quotaCols.quotaExpiresAt, nextResetAt,
        id,
      ]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  if (result) notifyApiKeysChanged();
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  const deleted = (res?.changes ?? 0) > 0;
  if (deleted) notifyApiKeysChanged();
  return deleted;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive, quotaExpiresAt FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  const active = row.isActive === 1 || row.isActive === true;
  return active && !isKeyQuotaExpired({ expiresAt: row.quotaExpiresAt });
}

// Atomically checks all configured limits and consumes one external request slot.
// Token/cost counters are reconciled later from the provider's exact usage record.
export async function admitApiKeyRequest(key) {
  if (!key) return { tracked: false, allowed: true };
  const db = await getAdapter();
  let result = { tracked: false, allowed: true };

  db.transaction(() => {
    let row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
    if (!row) return;

    const applied = applyDueQuotaReset(db, row);
    row = applied.row;

    const record = rowToKey(row);
    if (!record.isActive || record.isExpired) {
      result = {
        tracked: true,
        allowed: false,
        reason: record.isExpired ? "expired" : "inactive",
        expiresAt: record.quota.expiresAt,
        quota: record.quota,
        usage: record.usage,
      };
      return;
    }
    const exceeded = getExceededKeyQuota(record.quota, record.usage);
    if (exceeded) {
      result = { tracked: true, allowed: false, exceeded, quota: record.quota, usage: record.usage };
      return;
    }

    db.run(
      `UPDATE apiKeys SET quotaUsedRequests = COALESCE(quotaUsedRequests, 0) + 1 WHERE id = ?`,
      [row.id],
    );
    result = {
      tracked: true,
      allowed: true,
      quota: record.quota,
      usage: { ...record.usage, requests: record.usage.requests + 1 },
    };
  });

  if (result.tracked && result.allowed) notifyApiKeysChanged();

  return result;
}

export async function resetApiKeyUsage(id) {
  const db = await getAdapter();
  const resetAt = new Date().toISOString();
  const res = db.run(
    `UPDATE apiKeys SET
      quotaUsedCost = 0,
      quotaUsedInputTokens = 0,
      quotaUsedRequests = 0,
      quotaUsageResetAt = ?
     WHERE id = ?`,
    [resetAt, id],
  );
  if ((res?.changes ?? 0) === 0) return null;
  const key = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  notifyApiKeysChanged();
  return key;
}
