const DDL = [
  `CREATE TABLE IF NOT EXISTS executionPlans (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    createdBy TEXT NOT NULL,
    apiKeyId TEXT REFERENCES apiKeys(id) ON DELETE SET NULL,
    providerId TEXT NOT NULL,
    modelId TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('DRAFT','NEEDS_CLARIFICATION','OPTIONS_READY','PENDING_APPROVAL','APPROVED','EXECUTING','COMPLETED','FAILED','REJECTED','CANCELLED','STALE','EXPIRED')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    currentRevision INTEGER NOT NULL DEFAULT 0 CHECK (currentRevision >= 0),
    selectedOptionId TEXT REFERENCES planOptions(id) ON DELETE SET NULL,
    originalRequest TEXT NOT NULL,
    interpretedObjective TEXT NOT NULL DEFAULT '',
    assumptions TEXT NOT NULL DEFAULT '[]',
    missingInformation TEXT NOT NULL DEFAULT '[]',
    constraints TEXT NOT NULL DEFAULT '[]',
    affectedModules TEXT NOT NULL DEFAULT '[]',
    risks TEXT NOT NULL DEFAULT '[]',
    contextSnapshotId TEXT REFERENCES contextSnapshots(id) ON DELETE SET NULL,
    contextHash TEXT,
    contextTokenEstimate INTEGER NOT NULL DEFAULT 0,
    expiresAt TEXT,
    errorCode TEXT,
    errorMessage TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS planRevisions (
    id TEXT PRIMARY KEY,
    planId TEXT NOT NULL REFERENCES executionPlans(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    sourceRevision INTEGER,
    createdBy TEXT NOT NULL,
    feedback TEXT,
    content TEXT NOT NULL,
    usage TEXT NOT NULL DEFAULT '{}',
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS planOptions (
    id TEXT PRIMARY KEY,
    planId TEXT NOT NULL REFERENCES executionPlans(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    name TEXT NOT NULL,
    summary TEXT NOT NULL,
    content TEXT NOT NULL,
    recommended INTEGER NOT NULL DEFAULT 0 CHECK (recommended IN (0,1)),
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS planAuditLogs (
    id TEXT PRIMARY KEY,
    planId TEXT NOT NULL REFERENCES executionPlans(id) ON DELETE CASCADE,
    projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    actorId TEXT NOT NULL,
    eventType TEXT NOT NULL,
    fromStatus TEXT,
    toStatus TEXT,
    planVersion INTEGER NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    createdAt TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_execution_plans_project ON executionPlans(projectId, updatedAt DESC)",
  "CREATE INDEX IF NOT EXISTS idx_execution_plans_status ON executionPlans(projectId, status, updatedAt DESC)",
  "CREATE INDEX IF NOT EXISTS idx_execution_plans_creator ON executionPlans(createdBy, updatedAt DESC)",
  "CREATE INDEX IF NOT EXISTS idx_execution_plans_expiry ON executionPlans(status, expiresAt) WHERE expiresAt IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_revisions_number ON planRevisions(planId, revision)",
  "CREATE INDEX IF NOT EXISTS idx_plan_revisions_created ON planRevisions(planId, createdAt DESC)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_options_ordinal ON planOptions(planId, revision, ordinal)",
  "CREATE INDEX IF NOT EXISTS idx_plan_options_revision ON planOptions(planId, revision)",
  "CREATE INDEX IF NOT EXISTS idx_plan_audit_plan ON planAuditLogs(planId, createdAt)",
  "CREATE INDEX IF NOT EXISTS idx_plan_audit_project ON planAuditLogs(projectId, createdAt DESC)",
];

const migration = {
  version: 5,
  name: "planning-foundation",
  up(db) {
    for (const statement of DDL) db.exec(statement);
  },
};

export default migration;
