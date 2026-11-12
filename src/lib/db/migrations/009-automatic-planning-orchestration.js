const migration = {
  version: 9,
  name: "automatic-planning-orchestration",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS planningRequestBindings (
      id TEXT PRIMARY KEY,
      planId TEXT NOT NULL UNIQUE REFERENCES executionPlans(id) ON DELETE CASCADE,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      apiKeyId TEXT NOT NULL REFERENCES apiKeys(id) ON DELETE CASCADE,
      requestKeyHash TEXT NOT NULL,
      clientSessionHash TEXT,
      sourceEndpoint TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_planning_request_key ON planningRequestBindings(apiKeyId, requestKeyHash)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_planning_request_project ON planningRequestBindings(projectId, createdAt DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_planning_request_session ON planningRequestBindings(apiKeyId, clientSessionHash, createdAt DESC) WHERE clientSessionHash IS NOT NULL");
  },
};

export default migration;
