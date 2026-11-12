const migration = {
  version: 7,
  name: "codex-execution",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS planExecutions (
      id TEXT PRIMARY KEY,
      planId TEXT NOT NULL UNIQUE REFERENCES executionPlans(id) ON DELETE CASCADE,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      ticketId TEXT NOT NULL UNIQUE,
      workerId TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('QUEUED','EXECUTING','COMPLETED','FAILED','CANCELLED','STALE')),
      approvedRevision INTEGER NOT NULL CHECK (approvedRevision > 0),
      approvedPlanVersion INTEGER NOT NULL CHECK (approvedPlanVersion > 0),
      sourceRevision TEXT NOT NULL DEFAULT '{}',
      ticketHash TEXT NOT NULL UNIQUE,
      leaseUntil TEXT,
      heartbeatAt TEXT,
      cancelRequestedAt TEXT,
      exitStatus INTEGER,
      modifiedFiles TEXT NOT NULL DEFAULT '[]',
      diffSummary TEXT NOT NULL DEFAULT '',
      testResults TEXT NOT NULL DEFAULT '{}',
      filteredLogs TEXT NOT NULL DEFAULT '',
      tokenUsage TEXT NOT NULL DEFAULT '{}',
      errorCode TEXT,
      errorMessage TEXT,
      durationMs INTEGER,
      startedAt TEXT,
      completedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_plan_executions_project ON planExecutions(projectId, createdAt DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_plan_executions_status ON planExecutions(status, leaseUntil)");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_executions_plan ON planExecutions(planId)");
  },
};

export default migration;
