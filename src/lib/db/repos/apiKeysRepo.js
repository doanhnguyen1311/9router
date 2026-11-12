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
import {
  decryptV2UpstreamApiKey,
  encryptV2UpstreamApiKey,
  v2ProxySummaryFromRow,
  validateV2ProxyInput,
} from "@/lib/v2ProxyConfig.js";
import { hashApiKey, protectApiKey, revealApiKey } from "@/lib/apiKeyStorage.js";
import {
  KEY_PLANNING_DEFAULT,
  keyPlanningFromColumns,
  keyPlanningToColumns,
  validateKeyPlanningInput,
} from "@/shared/utils/keyPlanning.js";

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
    key: revealApiKey(row),
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
    allowKeyUsage: row.allowKeyUsage !== 0 && row.allowKeyUsage !== false,
    allowKeyUsageModelList: row.allowKeyUsageModelList !== 0 && row.allowKeyUsageModelList !== false,
    ownerId: row.ownerId || "local-admin",
    projectAccess: row.projectAccess !== 0 && row.projectAccess !== false,
    maxProjects: row.maxProjects === null || row.maxProjects === undefined ? null : Number(row.maxProjects),
    createdProjectCount: Number(row.createdProjectCount || 0),
    assignedProjectId: row.assignedProjectId || null,
    linkedProjects: Array.isArray(row.linkedProjects) ? row.linkedProjects : [],
    planning: keyPlanningFromColumns(row),
    v2Proxy: v2ProxySummaryFromRow(row),
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
  const row = db.get(`SELECT * FROM apiKeys WHERE keyHash = ? OR key = ?`, [hashApiKey(key), key]);
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

function enrichKeyRows(db, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const ids = rows.map((r) => r?.id).filter(Boolean);
  if (!ids.length) return rows;
  const placeholders = ids.map(() => "?").join(",");
  const assignedMap = new Map();
  const linkedMap = new Map();
  const createdCountMap = new Map();

  try {
    const activeRows = db.all(
      `SELECT apiKeyId, projectId FROM projectApiKeys WHERE apiKeyId IN (${placeholders})`,
      ids,
    );
    for (const r of activeRows) {
      assignedMap.set(r.apiKeyId, r.projectId);
    }
  } catch { /* ignore if table absent */ }

  try {
    const memberRows = db.all(
      `SELECT m.apiKeyId, p.id, p.name, p.description, p.status
       FROM projectApiKeyMembers m
       JOIN projects p ON p.id = m.projectId
       WHERE m.apiKeyId IN (${placeholders}) AND p.status <> 'archived'
       ORDER BY m.addedAt DESC`,
      ids,
    );
    for (const r of memberRows) {
      if (!linkedMap.has(r.apiKeyId)) linkedMap.set(r.apiKeyId, []);
      linkedMap.get(r.apiKeyId).push({
        id: r.id,
        name: r.name,
        description: r.description || "",
        status: r.status,
      });
    }
  } catch { /* ignore if table absent */ }

  try {
    const countRows = db.all(
      `SELECT createdByApiKeyId AS apiKeyId, COUNT(*) AS count
       FROM projects
       WHERE createdByApiKeyId IN (${placeholders}) AND status <> 'archived'
       GROUP BY createdByApiKeyId`,
      ids,
    );
    for (const r of countRows) {
      createdCountMap.set(r.apiKeyId, Number(r.count || 0));
    }
  } catch { /* ignore if column absent */ }

  return rows.map((row) => {
    if (!row) return row;
    return {
      ...row,
      assignedProjectId: assignedMap.get(row.id) ?? row.assignedProjectId ?? null,
      linkedProjects: linkedMap.get(row.id) || [],
      createdProjectCount: createdCountMap.get(row.id) ?? 0,
    };
  });
}

function enrichKeyRow(db, row) {
  if (!row) return null;
  return enrichKeyRows(db, [row])[0] || null;
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
    rows = enrichKeyRows(db, rows);
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
    row = enrichKeyRow(db, applied.row);
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
    const joined = db.get(
      `SELECT k.*, pak.projectId AS assignedProjectId
       FROM apiKeys k LEFT JOIN projectApiKeys pak ON pak.apiKeyId=k.id WHERE k.keyHash = ? OR k.key = ?`,
      [hashApiKey(key), key],
    );
    const applied = applyDueQuotaReset(db, joined);
    row = applied.row ? enrichKeyRow(db, { ...applied.row, assignedProjectId: joined?.assignedProjectId || null }) : null;
    changed = applied.changed;
  });
  if (changed) notifyApiKeysChanged();
  return rowToKey(row);
}

// Server-only lookup used by /v2. The client-facing key record contains only
// enabled/configured booleans; the destination and decrypted credential never
// leave this function's server-side return value.
export async function getV2ProxyConfigByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE keyHash = ? OR key = ?`, [hashApiKey(key), key]);
  if (!row) return null;
  const record = rowToKey(row);
  if (!record.v2Proxy.enabled) return { record, config: null, invalid: false };
  const upstreamApiKey = decryptV2UpstreamApiKey(row.v2UpstreamApiKeyEncrypted, row.machineId);
  if (!record.v2Proxy.configured || !upstreamApiKey) {
    return { record, config: null, invalid: true };
  }
  return {
    record,
    invalid: false,
    config: {
      upstreamBaseUrl: row.v2UpstreamBaseUrl,
      upstreamApiKey,
    },
  };
}

// Admin-only repository lookup. Callers must enforce an authenticated dashboard
// session before returning this plaintext configuration. Keeping this separate
// from rowToKey() prevents generic key-list and key-detail responses from ever
// materializing the hidden destination or credential.
export async function getV2ProxyAdminConfigById(id) {
  if (!id) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  if (!row) return null;

  const enabled = row.v2Enabled === 1 || row.v2Enabled === true;
  const upstreamApiKey = enabled
    ? decryptV2UpstreamApiKey(row.v2UpstreamApiKeyEncrypted, row.machineId)
    : null;
  const upstreamBaseUrl = enabled && typeof row.v2UpstreamBaseUrl === "string"
    ? row.v2UpstreamBaseUrl
    : null;

  return {
    enabled,
    upstreamBaseUrl,
    upstreamApiKey,
    configured: enabled && !!upstreamBaseUrl && !!upstreamApiKey,
    credentialReadable: !enabled || !!upstreamApiKey,
  };
}

export async function updateV2ProxyAdminConfigById(id, input) {
  const checked = validateV2ProxyInput(input);
  if (!checked.ok) {
    const error = new Error(checked.error);
    error.code = "INVALID_V2_PROXY_CONFIG";
    throw error;
  }

  const db = await getAdapter();
  const config = checked.value;
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;

    const encryptedUpstreamApiKey = config.enabled
      ? encryptV2UpstreamApiKey(config.upstreamApiKey, row.machineId)
      : null;
    db.run(
      `UPDATE apiKeys SET
        v2Enabled = ?,
        v2UpstreamBaseUrl = ?,
        v2UpstreamApiKeyEncrypted = ?
       WHERE id = ?`,
      [
        config.enabled ? 1 : 0,
        config.enabled ? config.upstreamBaseUrl : null,
        encryptedUpstreamApiKey,
        id,
      ],
    );

    result = {
      enabled: config.enabled,
      upstreamBaseUrl: config.enabled ? config.upstreamBaseUrl : null,
      upstreamApiKey: config.enabled ? config.upstreamApiKey : null,
      configured: config.enabled,
      credentialReadable: true,
    };
  });

  if (result) notifyApiKeysChanged();
  return result;
}

export async function createApiKey(name, machineId, quota = KEY_QUOTA_UNLIMITED, v2ProxyInput = undefined, ownerId = "local-admin") {
  if (!machineId) throw new Error("machineId is required");
  const checkedV2Proxy = validateV2ProxyInput(v2ProxyInput);
  if (!checkedV2Proxy.ok) {
    const error = new Error(checkedV2Proxy.error);
    error.code = "INVALID_V2_PROXY_CONFIG";
    throw error;
  }
  const v2Proxy = checkedV2Proxy.value;
  const encryptedUpstreamApiKey = v2Proxy.enabled
    ? encryptV2UpstreamApiKey(v2Proxy.upstreamApiKey, machineId)
    : null;
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
    allowKeyUsage: true,
    allowKeyUsageModelList: true,
    ownerId: typeof ownerId === "string" && ownerId.trim() ? ownerId.trim() : "local-admin",
    projectAccess: true,
    maxProjects: null,
    createdProjectCount: 0,
    assignedProjectId: null,
    linkedProjects: [],
    planning: { ...KEY_PLANNING_DEFAULT },
    v2Proxy: { enabled: v2Proxy.enabled, configured: v2Proxy.enabled },
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
  const protectedKey = protectApiKey(apiKey.key, apiKey.machineId);
  db.run(
    `INSERT INTO apiKeys(
      id, key, keyHash, keyEncrypted, name, machineId, isActive, createdAt,
      accessRestricted, accessAllow, accessAccountRestricted, accessAccountIds,
      modelAlias, selectedModel,
      v2Enabled, v2UpstreamBaseUrl, v2UpstreamApiKeyEncrypted,
      quotaMaxCost, quotaMaxInputTokens, quotaMaxRequests,
      quotaResetMode, quotaResetInterval, quotaResetIntervalValue, quotaResetIntervalUnit, quotaExpiresAt, quotaNextResetAt,
      quotaUsedCost, quotaUsedInputTokens, quotaUsedRequests,
      ownerId, projectAccess
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 1)`,
    [
      apiKey.id, protectedKey.storageKey, protectedKey.keyHash, protectedKey.keyEncrypted,
      apiKey.name, apiKey.machineId, 1, apiKey.createdAt,
      cols.accessRestricted, cols.accessAllow, cols.accessAccountRestricted, cols.accessAccountIds,
      null, null,
      v2Proxy.enabled ? 1 : 0, v2Proxy.upstreamBaseUrl, encryptedUpstreamApiKey,
      quotaCols.quotaMaxCost, quotaCols.quotaMaxInputTokens, quotaCols.quotaMaxRequests,
      quotaCols.quotaResetMode, quotaCols.quotaResetInterval,
      quotaCols.quotaResetIntervalValue, quotaCols.quotaResetIntervalUnit,
      quotaCols.quotaExpiresAt,
      apiKey.usage.nextResetAt,
      apiKey.ownerId,
    ]
  );
  notifyApiKeysChanged();
  return apiKey;
}

export async function updateApiKey(id, data, options = {}) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const current = rowToKey(row);
    if (options.keyUsageSelfService === true) {
      if (!current.allowKeyUsage) {
        const error = new Error("Key Usage is disabled for this API key");
        error.code = "KEY_USAGE_FORBIDDEN";
        throw error;
      }
      if (data.modelRouting !== undefined && !current.allowKeyUsageModelList) {
        const error = new Error("Model viewing and selection are disabled for this API key");
        error.code = "KEY_USAGE_MODEL_LIST_FORBIDDEN";
        throw error;
      }
    }
    for (const field of ["allowKeyUsage", "allowKeyUsageModelList", "projectAccess"]) {
      if (data[field] !== undefined && typeof data[field] !== "boolean") {
        const error = new Error(`${field} must be a boolean`);
        error.code = "INVALID_KEY_USAGE_ACCESS";
        throw error;
      }
    }
    if (data.maxProjects !== undefined) {
      if (options.keyUsageSelfService === true) {
        const error = new Error("Project creation limit is controlled by the administrator");
        error.code = "KEY_USAGE_FORBIDDEN";
        throw error;
      }
      if (data.maxProjects !== null && (!Number.isSafeInteger(data.maxProjects) || data.maxProjects < 0)) {
        const error = new Error("maxProjects must be null or a non-negative integer");
        error.code = "INVALID_KEY_MAX_PROJECTS";
        throw error;
      }
    }
    if (data.planning !== undefined) {
      if (options.keyUsageSelfService === true) {
        const error = new Error("Planning configuration is controlled by the administrator");
        error.code = "KEY_USAGE_FORBIDDEN";
        throw error;
      }
      const checked = validateKeyPlanningInput(data.planning);
      if (!checked.ok) {
        const error = new Error(checked.error);
        error.code = "INVALID_KEY_PLANNING";
        throw error;
      }
      data = { ...data, planning: checked.value };
    }
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
    const planningCols = keyPlanningToColumns(merged.planning).value;
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
    const machineChanged = merged.machineId !== row.machineId;
    let protectedKey = null;
    let rewrappedV2Key = row.v2UpstreamApiKeyEncrypted;
    if (machineChanged) {
      if (!current.key) throw new Error("API key credential cannot be rewrapped");
      protectedKey = protectApiKey(current.key, merged.machineId);
      if (row.v2UpstreamApiKeyEncrypted) {
        const upstreamKey = decryptV2UpstreamApiKey(row.v2UpstreamApiKeyEncrypted, row.machineId);
        if (!upstreamKey) throw new Error("V2 upstream credential cannot be rewrapped");
        rewrappedV2Key = encryptV2UpstreamApiKey(upstreamKey, merged.machineId);
      }
    }
    db.run(
      `UPDATE apiKeys SET
        name = ?, machineId = ?, isActive = ?, key = COALESCE(?, key), keyHash = COALESCE(?, keyHash),
        keyEncrypted = COALESCE(?, keyEncrypted), v2UpstreamApiKeyEncrypted = ?,
        accessRestricted = ?, accessAllow = ?, accessAccountRestricted = ?, accessAccountIds = ?,
        modelAlias = ?, selectedModel = ?, effortPolicy = ?,
        allowKeyUsage = ?, allowKeyUsageModelList = ?,
        projectAccess = ?, maxProjects = ?,
        planningEnabled = ?, planningMode = ?, planningProviderId = ?, planningModelId = ?,
        planningApprovalRequired = ?, planningContextTokenBudget = ?,
        planningPlanExpirationMinutes = ?, planningFailurePolicy = ?,
        quotaMaxCost = ?, quotaMaxInputTokens = ?, quotaMaxRequests = ?,
        quotaResetMode = ?, quotaResetInterval = ?,
        quotaResetIntervalValue = ?, quotaResetIntervalUnit = ?, quotaExpiresAt = ?, quotaNextResetAt = ?
       WHERE id = ?`,
      [
        merged.name, merged.machineId, merged.isActive ? 1 : 0,
        protectedKey?.storageKey || null, protectedKey?.keyHash || null, protectedKey?.keyEncrypted || null, rewrappedV2Key,
        cols.accessRestricted, cols.accessAllow, cols.accessAccountRestricted, cols.accessAccountIds,
        routingCols.modelAlias, routingCols.selectedModel,
        JSON.stringify(merged.effortPolicy),
        merged.allowKeyUsage ? 1 : 0, merged.allowKeyUsageModelList ? 1 : 0,
        merged.projectAccess ? 1 : 0, merged.maxProjects === undefined ? null : merged.maxProjects,
        planningCols.planningEnabled, planningCols.planningMode,
        planningCols.planningProviderId, planningCols.planningModelId,
        planningCols.planningApprovalRequired, planningCols.planningContextTokenBudget,
        planningCols.planningPlanExpirationMinutes, planningCols.planningFailurePolicy,
        quotaCols.quotaMaxCost, quotaCols.quotaMaxInputTokens, quotaCols.quotaMaxRequests,
        quotaCols.quotaResetMode, quotaCols.quotaResetInterval,
        quotaCols.quotaResetIntervalValue, quotaCols.quotaResetIntervalUnit,
        quotaCols.quotaExpiresAt, nextResetAt,
        id,
      ]
    );
    result = rowToKey(enrichKeyRow(db, db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id])));
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
  const row = db.get(`SELECT isActive, quotaExpiresAt FROM apiKeys WHERE keyHash = ? OR key = ?`, [hashApiKey(key), key]);
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
    let row = db.get(`SELECT * FROM apiKeys WHERE keyHash = ? OR key = ?`, [hashApiKey(key), key]);
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
  const key = rowToKey(enrichKeyRow(db, db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id])));
  notifyApiKeysChanged();
  return key;
}
