import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";
import {
  KEY_QUOTA_UNLIMITED,
  getExceededKeyQuota,
  keyQuotaFromColumns,
  keyQuotaToColumns,
  keyQuotaUsageFromColumns,
} from "@/shared/utils/keyQuota.js";

function rowToKey(row) {
  if (!row) return null;
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
    quota: keyQuotaFromColumns(row.quotaMaxCost, row.quotaMaxInputTokens, row.quotaMaxRequests),
    usage: keyQuotaUsageFromColumns(
      row.quotaUsedCost,
      row.quotaUsedInputTokens,
      row.quotaUsedRequests,
      row.quotaUsageResetAt,
    ),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, quota = KEY_QUOTA_UNLIMITED) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    access: { restricted: false, allow: [], accountRestricted: false, accountIds: [] },
    quota,
    usage: { cost: 0, inputTokens: 0, requests: 0, resetAt: null },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  const quotaCols = keyQuotaToColumns(quota);
  db.run(
    `INSERT INTO apiKeys(
      id, key, name, machineId, isActive, createdAt,
      accessRestricted, accessAllow, accessAccountRestricted, accessAccountIds,
      quotaMaxCost, quotaMaxInputTokens, quotaMaxRequests,
      quotaUsedCost, quotaUsedInputTokens, quotaUsedRequests
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
    [
      apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt,
      cols.accessRestricted, cols.accessAllow, cols.accessAccountRestricted, cols.accessAccountIds,
      quotaCols.quotaMaxCost, quotaCols.quotaMaxInputTokens, quotaCols.quotaMaxRequests,
    ]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    const cols = keyAccessToColumns(merged.access);
    const quotaCols = keyQuotaToColumns(merged.quota);
    db.run(
      `UPDATE apiKeys SET
        key = ?, name = ?, machineId = ?, isActive = ?,
        accessRestricted = ?, accessAllow = ?, accessAccountRestricted = ?, accessAccountIds = ?,
        quotaMaxCost = ?, quotaMaxInputTokens = ?, quotaMaxRequests = ?
       WHERE id = ?`,
      [
        merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0,
        cols.accessRestricted, cols.accessAllow, cols.accessAccountRestricted, cols.accessAccountIds,
        quotaCols.quotaMaxCost, quotaCols.quotaMaxInputTokens, quotaCols.quotaMaxRequests,
        id,
      ]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

// Atomically checks all configured limits and consumes one external request slot.
// Token/cost counters are reconciled later from the provider's exact usage record.
export async function admitApiKeyRequest(key) {
  if (!key) return { tracked: false, allowed: true };
  const db = await getAdapter();
  let result = { tracked: false, allowed: true };

  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
    if (!row) return;

    const record = rowToKey(row);
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
  return rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
}
