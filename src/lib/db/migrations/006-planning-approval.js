const KEY_COLUMNS = {
  planningEnabled: "INTEGER NOT NULL DEFAULT 0 CHECK (planningEnabled IN (0,1))",
  planningMode: "TEXT NOT NULL DEFAULT 'OFF' CHECK (planningMode IN ('OFF','MANUAL','ADAPTIVE'))",
  planningProviderId: "TEXT",
  planningModelId: "TEXT",
  planningApprovalRequired: "INTEGER NOT NULL DEFAULT 1 CHECK (planningApprovalRequired IN (0,1))",
  planningContextTokenBudget: "INTEGER NOT NULL DEFAULT 1800 CHECK (planningContextTokenBudget BETWEEN 256 AND 16000)",
  planningPlanExpirationMinutes: "INTEGER NOT NULL DEFAULT 10080 CHECK (planningPlanExpirationMinutes BETWEEN 5 AND 43200)",
  planningFailurePolicy: "TEXT NOT NULL DEFAULT 'FAIL_CLOSED' CHECK (planningFailurePolicy IN ('LEGACY_PATH','FAIL_CLOSED'))",
};

const migration = {
  version: 6,
  name: "planning-approval",
  up(db) {
    const existing = new Set(db.all("PRAGMA table_info(apiKeys)").map((column) => column.name));
    for (const [name, definition] of Object.entries(KEY_COLUMNS)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE apiKeys ADD COLUMN ${name} ${definition}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS planApprovals (
      id TEXT PRIMARY KEY,
      planId TEXT NOT NULL REFERENCES executionPlans(id) ON DELETE CASCADE,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      planVersion INTEGER NOT NULL CHECK (planVersion > 0),
      optionId TEXT NOT NULL REFERENCES planOptions(id) ON DELETE RESTRICT,
      decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
      scope TEXT NOT NULL CHECK (scope = 'EXECUTE_APPROVED_PLAN'),
      actorId TEXT NOT NULL,
      nonceHash TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL
    )`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_approvals_plan ON planApprovals(planId)");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_approvals_nonce ON planApprovals(nonceHash)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_plan_approvals_project ON planApprovals(projectId, createdAt DESC)");
  },
};

export default migration;
