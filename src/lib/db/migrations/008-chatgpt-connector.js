const migration = {
  version: 8,
  name: "chatgpt-web-mcp-connector",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS chatgptConnectors (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      createdBy TEXT NOT NULL,
      displayName TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE','REVOKED','EXPIRED')),
      allowedScopes TEXT NOT NULL DEFAULT '[]',
      allowPlanSubmit INTEGER NOT NULL DEFAULT 0 CHECK (allowPlanSubmit IN (0,1)),
      pairingCodeHash TEXT UNIQUE,
      pairingExpiresAt TEXT,
      pairingAttempts INTEGER NOT NULL DEFAULT 0 CHECK (pairingAttempts >= 0),
      pairedAt TEXT,
      expiresAt TEXT NOT NULL,
      revokedAt TEXT,
      lastUsedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS chatgptOauthClients (
      id TEXT PRIMARY KEY, clientName TEXT, redirectUris TEXT NOT NULL, createdAt TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS chatgptOauthRequests (
      id TEXT PRIMARY KEY,
      clientId TEXT NOT NULL REFERENCES chatgptOauthClients(id) ON DELETE CASCADE,
      redirectUri TEXT NOT NULL,
      codeChallenge TEXT NOT NULL,
      requestedScopes TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      state TEXT,
      resource TEXT,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS chatgptOauthCodes (
      codeHash TEXT PRIMARY KEY,
      connectorId TEXT NOT NULL REFERENCES chatgptConnectors(id) ON DELETE CASCADE,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      clientId TEXT NOT NULL REFERENCES chatgptOauthClients(id) ON DELETE CASCADE,
      redirectUri TEXT NOT NULL,
      codeChallenge TEXT NOT NULL,
      scopes TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      usedAt TEXT,
      createdAt TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS chatgptOauthTokens (
      id TEXT PRIMARY KEY,
      tokenHash TEXT NOT NULL UNIQUE,
      tokenType TEXT NOT NULL CHECK (tokenType IN ('access','refresh')),
      connectorId TEXT NOT NULL REFERENCES chatgptConnectors(id) ON DELETE CASCADE,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      clientId TEXT NOT NULL REFERENCES chatgptOauthClients(id) ON DELETE CASCADE,
      scopes TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      revokedAt TEXT,
      rotatedFromId TEXT REFERENCES chatgptOauthTokens(id) ON DELETE SET NULL,
      lastUsedAt TEXT,
      createdAt TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS chatgptConnectorAuditLogs (
      id TEXT PRIMARY KEY,
      connectorId TEXT REFERENCES chatgptConnectors(id) ON DELETE SET NULL,
      projectId TEXT REFERENCES projects(id) ON DELETE CASCADE,
      actorId TEXT NOT NULL,
      eventType TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS chatgptPlanSubmissions (
      id TEXT PRIMARY KEY,
      connectorId TEXT NOT NULL REFERENCES chatgptConnectors(id) ON DELETE CASCADE,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      planId TEXT NOT NULL UNIQUE REFERENCES executionPlans(id) ON DELETE CASCADE,
      idempotencyHash TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_chatgpt_connectors_project ON chatgptConnectors(projectId, createdAt DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chatgpt_connectors_status ON chatgptConnectors(status, expiresAt)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chatgpt_oauth_clients_created ON chatgptOauthClients(createdAt DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chatgpt_oauth_requests_expiry ON chatgptOauthRequests(expiresAt)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chatgpt_oauth_codes_expiry ON chatgptOauthCodes(expiresAt)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chatgpt_oauth_tokens_connector ON chatgptOauthTokens(connectorId, tokenType, expiresAt)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chatgpt_oauth_tokens_expiry ON chatgptOauthTokens(tokenType, expiresAt)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chatgpt_connector_audit_project ON chatgptConnectorAuditLogs(projectId, createdAt DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chatgpt_connector_audit_connector ON chatgptConnectorAuditLogs(connectorId, createdAt DESC)");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_chatgpt_submissions_idempotency ON chatgptPlanSubmissions(connectorId, idempotencyHash)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chatgpt_submissions_project ON chatgptPlanSubmissions(projectId, createdAt DESC)");
  },
};

export default migration;
