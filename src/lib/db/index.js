import { KEY_EFFORT_DEFAULT, keyEffortFromColumn, validateKeyEffortPolicy } from "@/shared/utils/keyEffort.js";
// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
import { keyAccessFromColumns, keyAccessToColumns, validateKeyAccessInput } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";
import {
  KEY_MODEL_ROUTING_DISABLED,
  keyModelRoutingFromColumns,
  keyModelRoutingToColumns,
  validateKeyModelRoutingInput,
} from "@/shared/utils/keyModelRouting.js";
import {
  KEY_QUOTA_UNLIMITED,
  getNextQuotaResetAt,
  keyQuotaFromColumns,
  keyQuotaToColumns,
  keyQuotaUsageFromColumns,
  validateKeyQuotaInput,
} from "@/shared/utils/keyQuota.js";
import { notifyApiKeysChanged } from "@/lib/apiKeyEvents.js";
import {
  isEncryptedV2UpstreamApiKey,
  normalizeV2UpstreamBaseUrl,
} from "@/lib/v2ProxyConfig.js";
import { isProtectedApiKeyRow, protectApiKey } from "@/lib/apiKeyStorage.js";
import { upsertSearchDocumentInTransaction } from "@/lib/projectMemory/searchIndex.js";
import {
  KEY_PLANNING_DEFAULT,
  keyPlanningFromColumns,
  keyPlanningToColumns,
  validateKeyPlanningInput,
} from "@/shared/utils/keyPlanning.js";

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, getApiKeyByKey, getV2ProxyConfigByKey,
  getV2ProxyAdminConfigById, updateV2ProxyAdminConfigById,
  createApiKey, updateApiKey, deleteApiKey, validateApiKey,
  admitApiKeyRequest, resetApiKeyUsage,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getApiKeyUsageSummary, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB
export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    settings: await exportSettings(),
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({
      id: r.id,
      key: r.key,
      keyHash: r.keyHash || null,
      keyEncrypted: r.keyEncrypted || null,
      name: r.name,
      machineId: r.machineId,
      isActive: r.isActive === 1,
      createdAt: r.createdAt,
      access: keyAccessFromColumns(
        r.accessRestricted,
        r.accessAllow,
        r.accessAccountRestricted,
        r.accessAccountIds,
      ),
      modelRouting: keyModelRoutingFromColumns(r.modelAlias, r.selectedModel),
      effortPolicy: keyEffortFromColumn(r.effortPolicy),
      allowKeyUsage: r.allowKeyUsage !== 0 && r.allowKeyUsage !== false,
      allowKeyUsageModelList: r.allowKeyUsageModelList !== 0 && r.allowKeyUsageModelList !== false,
      ownerId: r.ownerId || "local-admin",
      projectAccess: r.projectAccess !== 0 && r.projectAccess !== false,
      maxProjects: r.maxProjects === null || r.maxProjects === undefined ? null : Number(r.maxProjects),
      planning: keyPlanningFromColumns(r),
      v2Proxy: {
        enabled: r.v2Enabled === 1 || r.v2Enabled === true,
        upstreamBaseUrl: r.v2UpstreamBaseUrl || null,
        // Backups preserve the encrypted value; plaintext upstream credentials
        // are never materialized by exportDb().
        upstreamApiKeyEncrypted: r.v2UpstreamApiKeyEncrypted || null,
      },
      quota: keyQuotaFromColumns(
        r.quotaMaxCost,
        r.quotaMaxInputTokens,
        r.quotaMaxRequests,
        r.quotaResetMode,
        r.quotaResetInterval,
        r.quotaResetIntervalValue,
        r.quotaResetIntervalUnit,
        r.quotaExpiresAt,
      ),
      usage: keyQuotaUsageFromColumns(
        r.quotaUsedCost,
        r.quotaUsedInputTokens,
        r.quotaUsedRequests,
        r.quotaUsageResetAt,
        r.quotaNextResetAt,
      ),
    })),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
    projectMemory: {
      projectSystemSettings: db.all(`SELECT * FROM projectSystemSettings`),
      projectPermissions: db.all(`SELECT * FROM projectPermissions`),
      projects: db.all(`SELECT * FROM projects`),
      projectMembers: db.all(`SELECT * FROM projectMembers`),
      projectApiKeys: db.all(`SELECT * FROM projectApiKeys`),
      projectApiKeyMembers: db.all(`SELECT * FROM projectApiKeyMembers`),
      projectSettings: db.all(`SELECT * FROM projectSettings`),
      projectSessions: db.all(`SELECT * FROM projectSessions`),
      memoryEvents: db.all(`SELECT * FROM memoryEvents`),
      extractionJobs: db.all(`SELECT * FROM extractionJobs`),
      memoryItems: db.all(`SELECT * FROM memoryItems`),
      memoryItemHistory: db.all(`SELECT * FROM memoryItemHistory`),
      memoryEntities: db.all(`SELECT * FROM memoryEntities`),
      memoryRelations: db.all(`SELECT * FROM memoryRelations`),
      projectFiles: db.all(`SELECT * FROM projectFiles`),
      projectSymbols: db.all(`SELECT * FROM projectSymbols`),
      projectFileDependencies: db.all(`SELECT * FROM projectFileDependencies`),
      contextSnapshots: db.all(`SELECT * FROM contextSnapshots`),
      memoryUsage: db.all(`SELECT * FROM memoryUsage`),
      executionPlans: db.all(`SELECT * FROM executionPlans`),
      planningRequestBindings: db.all(`SELECT * FROM planningRequestBindings`),
      planRevisions: db.all(`SELECT * FROM planRevisions`),
      planOptions: db.all(`SELECT * FROM planOptions`),
      planAuditLogs: db.all(`SELECT * FROM planAuditLogs`),
      planApprovals: db.all(`SELECT * FROM planApprovals`),
      planExecutions: db.all(`SELECT * FROM planExecutions`),
      chatgptConnectors: db.all(`SELECT * FROM chatgptConnectors`),
      chatgptOauthClients: db.all(`SELECT * FROM chatgptOauthClients`),
      chatgptOauthRequests: db.all(`SELECT * FROM chatgptOauthRequests`),
      chatgptOauthCodes: db.all(`SELECT * FROM chatgptOauthCodes`),
      chatgptOauthTokens: db.all(`SELECT * FROM chatgptOauthTokens`),
      chatgptConnectorAuditLogs: db.all(`SELECT * FROM chatgptConnectorAuditLogs`),
      chatgptPlanSubmissions: db.all(`SELECT * FROM chatgptPlanSubmissions`),
    },
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);

  return out;
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();

  function insertRawRows(table, rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    const allowed = new Set(db.all(`PRAGMA table_info(${table})`).map((column) => column.name));
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const columns = Object.keys(row).filter((column) => allowed.has(column));
      if (!columns.length) continue;
      db.run(
        `INSERT OR REPLACE INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
        columns.map((column) => row[column]),
      );
    }
  }

  db.transaction(() => {
    const projectDump = payload.projectMemory && typeof payload.projectMemory === "object" && !Array.isArray(payload.projectMemory)
      ? payload.projectMemory
      : null;
    if (projectDump) {
      // Planning introduces a valid cycle: a plan may select an option, and
      // that option belongs to the plan. Defer FK checks until the complete
      // project graph has been restored atomically.
      db.exec("PRAGMA defer_foreign_keys = ON");
      db.run(`DELETE FROM chatgptOauthClients`);
      // One root delete cascades every project-owned row and API-key mapping.
      db.run(`DELETE FROM projects`);
      db.run(`DELETE FROM projectPermissions`);
      db.run(`DELETE FROM projectSystemSettings`);
    }
    // Wipe all tables (keep _meta)
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM combos`);
    db.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')`);

    // Settings
    if (payload.settings) {
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    }

    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    const importedModelAliases = new Set();
    for (const k of payload.apiKeys || []) {
      // Per-key access: a backup without `access` (older version) restores
      // unrestricted, exactly as before; a malformed `access` is refused.
      let access = KEY_ACCESS_UNRESTRICTED;
      if (k.access !== undefined) {
        const checked = validateKeyAccessInput(k.access);
        if (!checked.ok) throw new Error(`apiKeys ${k.id}: ${checked.error}`);
        access = checked.value;
      }
      let effortPolicy = KEY_EFFORT_DEFAULT;
      if (k.effortPolicy !== undefined) {
        const checked = validateKeyEffortPolicy(k.effortPolicy);
        if (!checked.ok) throw new Error(`apiKeys ${k.id}: ${checked.error}`);
        effortPolicy = checked.value;
      }
      const allowKeyUsage = k.allowKeyUsage === undefined ? true : k.allowKeyUsage;
      const allowKeyUsageModelList = k.allowKeyUsageModelList === undefined
        ? true
        : k.allowKeyUsageModelList;
      if (typeof allowKeyUsage !== "boolean" || typeof allowKeyUsageModelList !== "boolean") {
        throw new Error(`apiKeys ${k.id}: Key Usage access values must be booleans`);
      }
      const ownerId = typeof k.ownerId === "string" && k.ownerId.trim() ? k.ownerId.trim() : "local-admin";
      const projectAccess = k.projectAccess === undefined ? true : k.projectAccess;
      if (typeof projectAccess !== "boolean") throw new Error(`apiKeys ${k.id}: projectAccess must be boolean`);
      const maxProjects = k.maxProjects === undefined || k.maxProjects === null
        ? null
        : (Number.isSafeInteger(Number(k.maxProjects)) && Number(k.maxProjects) >= 0 ? Number(k.maxProjects) : null);
      let planning = KEY_PLANNING_DEFAULT;
      if (k.planning !== undefined) {
        const checked = validateKeyPlanningInput(k.planning);
        if (!checked.ok) throw new Error(`apiKeys ${k.id}: ${checked.error}`);
        planning = checked.value;
      }
      const planningCols = keyPlanningToColumns(planning).value;
      const protectedKey = isProtectedApiKeyRow(k)
        ? { storageKey: k.key, keyHash: k.keyHash, keyEncrypted: k.keyEncrypted }
        : protectApiKey(k.key, k.machineId);
      let v2Enabled = false;
      let v2UpstreamBaseUrl = null;
      let v2UpstreamApiKeyEncrypted = null;
      if (k.v2Proxy !== undefined) {
        if (!k.v2Proxy || typeof k.v2Proxy !== "object" || Array.isArray(k.v2Proxy)
          || typeof k.v2Proxy.enabled !== "boolean") {
          throw new Error(`apiKeys ${k.id}: Invalid v2 proxy configuration`);
        }
        v2Enabled = k.v2Proxy.enabled;
        if (v2Enabled) {
          try {
            v2UpstreamBaseUrl = normalizeV2UpstreamBaseUrl(k.v2Proxy.upstreamBaseUrl);
          } catch (error) {
            throw new Error(`apiKeys ${k.id}: ${error.message}`);
          }
          if (!isEncryptedV2UpstreamApiKey(k.v2Proxy.upstreamApiKeyEncrypted)) {
            throw new Error(`apiKeys ${k.id}: Invalid encrypted v2 upstream API key`);
          }
          v2UpstreamApiKeyEncrypted = k.v2Proxy.upstreamApiKeyEncrypted;
        }
      }
      const cols = keyAccessToColumns(access);
      let modelRouting = KEY_MODEL_ROUTING_DISABLED;
      if (k.modelRouting !== undefined) {
        const checked = validateKeyModelRoutingInput(k.modelRouting, access);
        if (!checked.ok) throw new Error(`apiKeys ${k.id}: ${checked.error}`);
        modelRouting = checked.value;
      }
      if (modelRouting.alias) {
        const normalizedAlias = modelRouting.alias.toLowerCase();
        if (importedModelAliases.has(normalizedAlias)) {
          throw new Error(`apiKeys ${k.id}: duplicate public model name`);
        }
        importedModelAliases.add(normalizedAlias);
      }
      const routingCols = keyModelRoutingToColumns(modelRouting);
      let quota = KEY_QUOTA_UNLIMITED;
      if (k.quota !== undefined) {
        const checked = validateKeyQuotaInput(k.quota);
        if (!checked.ok) throw new Error(`apiKeys ${k.id}: ${checked.error}`);
        quota = checked.value;
      }
      const quotaCols = keyQuotaToColumns(quota);
      const usage = k.usage && typeof k.usage === "object" && !Array.isArray(k.usage) ? k.usage : {};
      const usageCost = Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : 0;
      const usageInputTokens = Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 ? usage.inputTokens : 0;
      const usageRequests = Number.isSafeInteger(usage.requests) && usage.requests >= 0 ? usage.requests : 0;
      const usageResetAt = typeof usage.resetAt === "string" && usage.resetAt ? usage.resetAt : null;
      const parsedNextReset = typeof usage.nextResetAt === "string" ? new Date(usage.nextResetAt) : null;
      const usageNextResetAt = quota.resetMode === "scheduled"
        ? (parsedNextReset && Number.isFinite(parsedNextReset.getTime())
          ? parsedNextReset.toISOString()
          : getNextQuotaResetAt(
            quota.resetInterval,
            new Date(),
            quota.resetIntervalValue,
            quota.resetIntervalUnit,
          ))
        : null;
      db.run(
        `INSERT OR REPLACE INTO apiKeys(
          id, key, keyHash, keyEncrypted, name, machineId, isActive, createdAt,
          accessRestricted, accessAllow, accessAccountRestricted, accessAccountIds,
          modelAlias, selectedModel, effortPolicy, allowKeyUsage, allowKeyUsageModelList,
          v2Enabled, v2UpstreamBaseUrl, v2UpstreamApiKeyEncrypted,
          quotaMaxCost, quotaMaxInputTokens, quotaMaxRequests,
          quotaResetMode, quotaResetInterval, quotaResetIntervalValue, quotaResetIntervalUnit, quotaExpiresAt, quotaNextResetAt,
          quotaUsedCost, quotaUsedInputTokens, quotaUsedRequests, quotaUsageResetAt
          , ownerId, projectAccess, maxProjects,
          planningEnabled, planningMode, planningProviderId, planningModelId,
          planningApprovalRequired, planningContextTokenBudget, planningPlanExpirationMinutes, planningFailurePolicy
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          k.id, protectedKey.storageKey, protectedKey.keyHash, protectedKey.keyEncrypted,
          k.name || null, k.machineId || null, k.isActive === false ? 0 : 1,
          k.createdAt || new Date().toISOString(),
          cols.accessRestricted, cols.accessAllow, cols.accessAccountRestricted, cols.accessAccountIds,
          routingCols.modelAlias, routingCols.selectedModel, JSON.stringify(effortPolicy),
          allowKeyUsage ? 1 : 0, allowKeyUsageModelList ? 1 : 0,
          v2Enabled ? 1 : 0, v2UpstreamBaseUrl, v2UpstreamApiKeyEncrypted,
          quotaCols.quotaMaxCost, quotaCols.quotaMaxInputTokens, quotaCols.quotaMaxRequests,
          quotaCols.quotaResetMode, quotaCols.quotaResetInterval,
          quotaCols.quotaResetIntervalValue, quotaCols.quotaResetIntervalUnit,
          quotaCols.quotaExpiresAt, usageNextResetAt,
          usageCost, usageInputTokens, usageRequests, usageResetAt,
          ownerId, projectAccess ? 1 : 0, maxProjects,
          planningCols.planningEnabled, planningCols.planningMode,
          planningCols.planningProviderId, planningCols.planningModelId,
          planningCols.planningApprovalRequired, planningCols.planningContextTokenBudget,
          planningCols.planningPlanExpirationMinutes, planningCols.planningFailurePolicy,
        ]
      );
    }
    for (const c of payload.combos || []) {
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    if (projectDump) {
      // Dependency order mirrors the foreign-key graph. Restore happens inside
      // the same transaction as API keys so assignments are never half-restored.
      insertRawRows("projectSystemSettings", projectDump.projectSystemSettings);
      insertRawRows("projectPermissions", projectDump.projectPermissions);
      insertRawRows("projects", projectDump.projects);
      insertRawRows("projectMembers", projectDump.projectMembers);
      insertRawRows("projectSettings", projectDump.projectSettings);
      insertRawRows("projectApiKeys", projectDump.projectApiKeys);
      insertRawRows("projectApiKeyMembers", projectDump.projectApiKeyMembers);
      db.exec(`INSERT OR IGNORE INTO projectApiKeyMembers(projectId, apiKeyId, addedBy, addedAt)
        SELECT projectId, apiKeyId, assignedBy, assignedAt FROM projectApiKeys`);
      insertRawRows("projectSessions", projectDump.projectSessions);
      insertRawRows("memoryEvents", projectDump.memoryEvents);
      insertRawRows("extractionJobs", projectDump.extractionJobs);
      insertRawRows("memoryItems", projectDump.memoryItems);
      insertRawRows("memoryItemHistory", projectDump.memoryItemHistory);
      insertRawRows("memoryEntities", projectDump.memoryEntities);
      insertRawRows("memoryRelations", projectDump.memoryRelations);
      insertRawRows("projectFiles", projectDump.projectFiles);
      insertRawRows("projectSymbols", projectDump.projectSymbols);
      insertRawRows("projectFileDependencies", projectDump.projectFileDependencies);
      insertRawRows("contextSnapshots", projectDump.contextSnapshots);
      insertRawRows("memoryUsage", projectDump.memoryUsage);
      insertRawRows("executionPlans", projectDump.executionPlans);
      insertRawRows("planningRequestBindings", projectDump.planningRequestBindings);
      insertRawRows("planRevisions", projectDump.planRevisions);
      insertRawRows("planOptions", projectDump.planOptions);
      insertRawRows("planAuditLogs", projectDump.planAuditLogs);
      insertRawRows("planApprovals", projectDump.planApprovals);
      insertRawRows("planExecutions", projectDump.planExecutions);
      insertRawRows("chatgptConnectors", projectDump.chatgptConnectors);
      insertRawRows("chatgptOauthClients", projectDump.chatgptOauthClients);
      insertRawRows("chatgptOauthRequests", projectDump.chatgptOauthRequests);
      insertRawRows("chatgptOauthCodes", projectDump.chatgptOauthCodes);
      insertRawRows("chatgptOauthTokens", projectDump.chatgptOauthTokens);
      insertRawRows("chatgptConnectorAuditLogs", projectDump.chatgptConnectorAuditLogs);
      insertRawRows("chatgptPlanSubmissions", projectDump.chatgptPlanSubmissions);
      for (const row of db.all("SELECT projectId, id, subject, value FROM memoryItems")) {
        upsertSearchDocumentInTransaction(db, { projectId: row.projectId, kind: "memory", refId: row.id, title: row.subject, body: row.value });
      }
      for (const row of db.all("SELECT projectId, id, relativePath, redactedContent FROM projectFiles")) {
        upsertSearchDocumentInTransaction(db, { projectId: row.projectId, kind: "file", refId: row.id, title: row.relativePath, body: row.redactedContent || "" });
      }
      if (!db.get(`SELECT id FROM projectSystemSettings WHERE id=1`)) {
        const now = new Date().toISOString();
        db.run(`INSERT INTO projectSystemSettings(id, enabled, defaultUserAccess, extractionEnabled, retrievalEnabled, fileIndexingEnabled, maxProjectsPerUser, maxFilesPerProject, maxProjectBytes, maxFileBytes, updatedAt) VALUES(1,1,1,1,1,1,50,5000,268435456,10485760,?)`, [now]);
      }
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
  });

  notifyApiKeysChanged();
  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
