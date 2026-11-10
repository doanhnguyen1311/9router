// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
export const SCHEMA_VERSION = 13;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA secure_delete = ON;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      keyHash: "TEXT",
      keyEncrypted: "TEXT",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      // Per-key access control. Additive columns, picked up by
      // syncSchemaFromTables() on boot; existing rows read as unrestricted (0).
      accessRestricted: "INTEGER DEFAULT 0",
      accessAllow: "TEXT",
      accessAccountRestricted: "INTEGER DEFAULT 0",
      accessAccountIds: "TEXT",
      // Optional public model name for this key. Calls to it route to the
      // key owner's currently selected member of accessAllow.
      modelAlias: "TEXT COLLATE NOCASE",
      selectedModel: "TEXT",
      // NULL preserves existing client-controlled effort. Corrupt JSON fails closed.
      effortPolicy: "TEXT",
      // Self-service visibility. Existing and new keys retain the historical
      // behavior by default; the model-list permission is a child of Key Usage.
      allowKeyUsage: "INTEGER DEFAULT 1",
      allowKeyUsageModelList: "INTEGER DEFAULT 1",
      // Optional v2 reverse-proxy destination. The upstream credential is
      // authenticated encryption and is never returned by key-list APIs.
      v2Enabled: "INTEGER DEFAULT 0",
      v2UpstreamBaseUrl: "TEXT",
      v2UpstreamApiKeyEncrypted: "TEXT",
      // Optional per-window quotas and their resettable counters. NULL limit = unlimited.
      quotaMaxCost: "REAL",
      quotaMaxInputTokens: "INTEGER",
      quotaMaxRequests: "INTEGER",
      quotaResetMode: "TEXT DEFAULT 'manual'",
      quotaResetInterval: "TEXT",
      quotaResetIntervalValue: "INTEGER",
      quotaResetIntervalUnit: "TEXT",
      quotaExpiresAt: "TEXT",
      quotaNextResetAt: "TEXT",
      quotaUsedCost: "REAL DEFAULT 0",
      quotaUsedInputTokens: "INTEGER DEFAULT 0",
      quotaUsedRequests: "INTEGER DEFAULT 0",
      quotaUsageResetAt: "TEXT",
      // Project Memory is opt-in. ownerId backfills the current single-admin
      // installation model while remaining compatible with OIDC/SAML users.
      ownerId: "TEXT DEFAULT 'local-admin'",
      projectAccess: "INTEGER NOT NULL DEFAULT 1",
      maxProjects: "INTEGER",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ak_key_hash ON apiKeys(keyHash) WHERE keyHash IS NOT NULL",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ak_model_alias_unique ON apiKeys(modelAlias COLLATE NOCASE) WHERE modelAlias IS NOT NULL AND modelAlias <> ''",
    ],
  },
  projectSystemSettings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      enabled: "INTEGER NOT NULL DEFAULT 1",
      defaultUserAccess: "INTEGER NOT NULL DEFAULT 1",
      extractionEnabled: "INTEGER NOT NULL DEFAULT 1",
      retrievalEnabled: "INTEGER NOT NULL DEFAULT 1",
      fileIndexingEnabled: "INTEGER NOT NULL DEFAULT 1",
      maxProjectsPerUser: "INTEGER NOT NULL DEFAULT 50",
      maxFilesPerProject: "INTEGER NOT NULL DEFAULT 5000",
      maxProjectBytes: "INTEGER NOT NULL DEFAULT 268435456",
      maxFileBytes: "INTEGER NOT NULL DEFAULT 10485760",
      updatedAt: "TEXT NOT NULL",
    },
  },
  projectPermissions: {
    columns: {
      principalId: "TEXT PRIMARY KEY",
      enabled: "INTEGER NOT NULL DEFAULT 1",
      updatedBy: "TEXT",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_project_permissions_enabled ON projectPermissions(enabled)"],
  },
  projects: {
    columns: {
      id: "TEXT PRIMARY KEY",
      ownerId: "TEXT NOT NULL",
      createdByApiKeyId: "TEXT REFERENCES apiKeys(id) ON DELETE SET NULL",
      name: "TEXT NOT NULL",
      nameKey: "TEXT",
      description: "TEXT NOT NULL DEFAULT ''",
      status: "TEXT NOT NULL DEFAULT 'active'",
      version: "INTEGER NOT NULL DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      lastActivityAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(ownerId, updatedAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status, updatedAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_projects_created_by_key ON projects(createdByApiKeyId)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name_key_unique ON projects(nameKey) WHERE nameKey IS NOT NULL",
    ],
  },
  projectMembers: {
    columns: {
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      principalId: "TEXT NOT NULL",
      role: "TEXT NOT NULL",
      displayName: "TEXT",
      status: "TEXT NOT NULL DEFAULT 'active'",
      invitedBy: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (projectId, principalId)",
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_project_members_principal ON projectMembers(principalId, status)",
      "CREATE INDEX IF NOT EXISTS idx_project_members_project ON projectMembers(projectId, status)",
    ],
  },
  projectApiKeys: {
    columns: {
      apiKeyId: "TEXT PRIMARY KEY REFERENCES apiKeys(id) ON DELETE CASCADE",
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      assignedBy: "TEXT NOT NULL",
      assignedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_project_api_keys_project ON projectApiKeys(projectId)"],
  },
  projectApiKeyMembers: {
    columns: {
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      apiKeyId: "TEXT NOT NULL REFERENCES apiKeys(id) ON DELETE CASCADE",
      addedBy: "TEXT NOT NULL",
      addedAt: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (projectId, apiKeyId)",
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pakm_key ON projectApiKeyMembers(apiKeyId)",
      "CREATE INDEX IF NOT EXISTS idx_pakm_project ON projectApiKeyMembers(projectId)",
    ],
  },
  projectSettings: {
    columns: {
      projectId: "TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE",
      memoryEnabled: "INTEGER NOT NULL DEFAULT 1",
      extractionEnabled: "INTEGER NOT NULL DEFAULT 1",
      retrievalEnabled: "INTEGER NOT NULL DEFAULT 1",
      fileIndexingEnabled: "INTEGER NOT NULL DEFAULT 1",
      contextTokenBudget: "INTEGER NOT NULL DEFAULT 1800",
      maxGraphDepth: "INTEGER NOT NULL DEFAULT 2",
      retainSourceContent: "INTEGER NOT NULL DEFAULT 1",
      ignoreRules: "TEXT NOT NULL DEFAULT '[]'",
      updatedAt: "TEXT NOT NULL",
    },
  },
  projectSessions: {
    columns: {
      id: "TEXT PRIMARY KEY",
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      apiKeyId: "TEXT REFERENCES apiKeys(id) ON DELETE SET NULL",
      clientNamespace: "TEXT NOT NULL",
      clientSessionId: "TEXT NOT NULL",
      provider: "TEXT",
      accountId: "TEXT",
      sessionVersion: "INTEGER NOT NULL DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      lastActivityAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_project_session_identity ON projectSessions(projectId, clientNamespace, clientSessionId)",
      "CREATE INDEX IF NOT EXISTS idx_project_sessions_activity ON projectSessions(projectId, lastActivityAt DESC)",
    ],
  },
  memoryEvents: {
    columns: {
      id: "TEXT PRIMARY KEY",
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      sessionId: "TEXT REFERENCES projectSessions(id) ON DELETE SET NULL",
      eventType: "TEXT NOT NULL",
      sourceType: "TEXT NOT NULL",
      payload: "TEXT NOT NULL",
      evidenceHash: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      processedAt: "TEXT",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_events_dedupe ON memoryEvents(projectId, evidenceHash, eventType)",
      "CREATE INDEX IF NOT EXISTS idx_memory_events_project_time ON memoryEvents(projectId, createdAt DESC)",
    ],
  },
  extractionJobs: {
    columns: {
      id: "TEXT PRIMARY KEY",
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      eventId: "TEXT REFERENCES memoryEvents(id) ON DELETE CASCADE",
      jobType: "TEXT NOT NULL DEFAULT 'memory-extraction'",
      state: "TEXT NOT NULL DEFAULT 'pending'",
      idempotencyKey: "TEXT NOT NULL UNIQUE",
      payload: "TEXT NOT NULL",
      attempts: "INTEGER NOT NULL DEFAULT 0",
      maxAttempts: "INTEGER NOT NULL DEFAULT 5",
      availableAt: "TEXT NOT NULL",
      leaseOwner: "TEXT",
      leaseUntil: "TEXT",
      lastError: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      completedAt: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_extraction_jobs_claim ON extractionJobs(state, availableAt, leaseUntil)",
      "CREATE INDEX IF NOT EXISTS idx_extraction_jobs_project ON extractionJobs(projectId, createdAt DESC)",
    ],
  },
  memoryItems: {
    columns: {
      id: "TEXT PRIMARY KEY",
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      memoryType: "TEXT NOT NULL",
      subject: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
      structuredContent: "TEXT NOT NULL",
      confidence: "REAL NOT NULL DEFAULT 0.5",
      sourceType: "TEXT NOT NULL",
      sourceSessionId: "TEXT REFERENCES projectSessions(id) ON DELETE SET NULL",
      sourceEventId: "TEXT REFERENCES memoryEvents(id) ON DELETE SET NULL",
      evidenceReference: "TEXT",
      fingerprint: "TEXT NOT NULL",
      version: "INTEGER NOT NULL DEFAULT 1",
      status: "TEXT NOT NULL DEFAULT 'active'",
      pinned: "INTEGER NOT NULL DEFAULT 0",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_fingerprint ON memoryItems(projectId, fingerprint)",
      "CREATE INDEX IF NOT EXISTS idx_memory_items_lookup ON memoryItems(projectId, status, memoryType, updatedAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_memory_items_subject ON memoryItems(projectId, subject)",
    ],
  },
  memoryItemHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      memoryId: "TEXT NOT NULL REFERENCES memoryItems(id) ON DELETE CASCADE",
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      version: "INTEGER NOT NULL",
      snapshot: "TEXT NOT NULL",
      reason: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_memory_history_item ON memoryItemHistory(memoryId, version DESC)"],
  },
  memoryEntities: {
    columns: {
      id: "TEXT PRIMARY KEY",
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      entityType: "TEXT NOT NULL",
      name: "TEXT NOT NULL",
      normalizedName: "TEXT NOT NULL",
      metadata: "TEXT NOT NULL DEFAULT '{}'",
      sourceType: "TEXT NOT NULL",
      confidence: "REAL NOT NULL DEFAULT 0.5",
      version: "INTEGER NOT NULL DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entities_name ON memoryEntities(projectId, entityType, normalizedName)",
      "CREATE INDEX IF NOT EXISTS idx_memory_entities_search ON memoryEntities(projectId, normalizedName)",
    ],
  },
  memoryRelations: {
    columns: {
      id: "TEXT PRIMARY KEY",
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      fromEntityId: "TEXT NOT NULL REFERENCES memoryEntities(id) ON DELETE CASCADE",
      toEntityId: "TEXT NOT NULL REFERENCES memoryEntities(id) ON DELETE CASCADE",
      relationType: "TEXT NOT NULL",
      evidenceType: "TEXT NOT NULL",
      evidenceReference: "TEXT",
      confidence: "REAL NOT NULL DEFAULT 0.5",
      version: "INTEGER NOT NULL DEFAULT 1",
      status: "TEXT NOT NULL DEFAULT 'active'",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_rel_unique ON memoryRelations(projectId, fromEntityId, toEntityId, relationType, evidenceType)",
      "CREATE INDEX IF NOT EXISTS idx_memory_rel_from ON memoryRelations(projectId, fromEntityId, status)",
      "CREATE INDEX IF NOT EXISTS idx_memory_rel_to ON memoryRelations(projectId, toEntityId, status)",
    ],
  },
  projectFiles: {
    columns: {
      id: "TEXT PRIMARY KEY",
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      relativePath: "TEXT NOT NULL",
      fileName: "TEXT NOT NULL",
      extension: "TEXT",
      language: "TEXT",
      contentHash: "TEXT NOT NULL",
      fileSize: "INTEGER NOT NULL",
      lastModified: "TEXT",
      indexedAt: "TEXT",
      indexingStatus: "TEXT NOT NULL DEFAULT 'pending'",
      parserVersion: "TEXT",
      redactedContent: "TEXT",
      storagePath: "TEXT",
      secretCount: "INTEGER NOT NULL DEFAULT 0",
      error: "TEXT",
      version: "INTEGER NOT NULL DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_project_files_path ON projectFiles(projectId, relativePath)",
      "CREATE INDEX IF NOT EXISTS idx_project_files_status ON projectFiles(projectId, indexingStatus, updatedAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_project_files_hash ON projectFiles(projectId, contentHash)",
    ],
  },
  projectSymbols: {
    columns: {
      id: "TEXT PRIMARY KEY",
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      fileId: "TEXT NOT NULL REFERENCES projectFiles(id) ON DELETE CASCADE",
      symbolType: "TEXT NOT NULL",
      name: "TEXT NOT NULL",
      qualifiedName: "TEXT",
      lineStart: "INTEGER",
      lineEnd: "INTEGER",
      signature: "TEXT",
      metadata: "TEXT NOT NULL DEFAULT '{}'",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_project_symbols_name ON projectSymbols(projectId, name)",
      "CREATE INDEX IF NOT EXISTS idx_project_symbols_file ON projectSymbols(fileId, lineStart)",
    ],
  },
  projectFileDependencies: {
    columns: {
      id: "TEXT PRIMARY KEY",
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      sourceFileId: "TEXT NOT NULL REFERENCES projectFiles(id) ON DELETE CASCADE",
      targetFileId: "TEXT REFERENCES projectFiles(id) ON DELETE CASCADE",
      targetReference: "TEXT NOT NULL",
      relationType: "TEXT NOT NULL",
      evidenceType: "TEXT NOT NULL",
      evidenceReference: "TEXT",
      confidence: "REAL NOT NULL DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_project_dep_unique ON projectFileDependencies(projectId, sourceFileId, targetReference, relationType)",
      "CREATE INDEX IF NOT EXISTS idx_project_dep_source ON projectFileDependencies(projectId, sourceFileId)",
      "CREATE INDEX IF NOT EXISTS idx_project_dep_target ON projectFileDependencies(projectId, targetFileId)",
    ],
  },
  contextSnapshots: {
    columns: {
      id: "TEXT PRIMARY KEY",
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      sessionId: "TEXT REFERENCES projectSessions(id) ON DELETE CASCADE",
      snapshotType: "TEXT NOT NULL",
      version: "INTEGER NOT NULL",
      contentHash: "TEXT NOT NULL",
      content: "TEXT NOT NULL",
      tokenEstimate: "INTEGER NOT NULL DEFAULT 0",
      status: "TEXT NOT NULL DEFAULT 'active'",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_context_snapshot_version ON contextSnapshots(projectId, sessionId, snapshotType, version)",
      "CREATE INDEX IF NOT EXISTS idx_context_snapshot_hash ON contextSnapshots(projectId, contentHash)",
    ],
  },
  memoryUsage: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      projectId: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE",
      sessionId: "TEXT REFERENCES projectSessions(id) ON DELETE SET NULL",
      operation: "TEXT NOT NULL",
      durationMs: "INTEGER NOT NULL DEFAULT 0",
      itemCount: "INTEGER NOT NULL DEFAULT 0",
      tokenEstimate: "INTEGER NOT NULL DEFAULT 0",
      status: "TEXT NOT NULL",
      metadata: "TEXT NOT NULL DEFAULT '{}'",
      createdAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_memory_usage_project ON memoryUsage(projectId, createdAt DESC)"],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_uh_api_key_ts ON usageHistory(apiKey, timestamp DESC)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
