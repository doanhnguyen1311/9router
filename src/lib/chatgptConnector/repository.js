import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { requireProjectRole } from "@/lib/projectMemory/repository.js";
import {
  CHATGPT_CONNECTOR_LIMITS,
  CHATGPT_CONNECTOR_READ_SCOPES,
  CHATGPT_CONNECTOR_SCOPES,
  connectorError,
} from "./constants.js";
import {
  base64UrlSha256,
  createOpaqueToken,
  createPairingCode,
  normalizePairingCode,
  sanitizeConnectorData,
  sha256,
} from "./security.js";

const iso = (value = Date.now()) => new Date(value).toISOString();

function parseConnector(row) {
  if (!row) return null;
  const { pairingCodeHash: _pairingCodeHash, ...safe } = row;
  return {
    ...safe,
    allowedScopes: parseJson(row.allowedScopes, []),
    allowPlanSubmit: row.allowPlanSubmit === 1 || row.allowPlanSubmit === true,
  };
}

function parseTokenRow(row) {
  return row ? { ...row, scopes: parseJson(row.scopes, []) } : null;
}

function cleanAuditMetadata(metadata) {
  const clean = sanitizeConnectorData(metadata || {});
  const text = JSON.stringify(clean);
  return text.length <= 8000 ? text : JSON.stringify({ truncated: true, preview: text.slice(0, 7800) });
}

function audit(db, { connectorId = null, projectId = null, actorId, eventType, metadata = {} }) {
  db.run(
    `INSERT INTO chatgptConnectorAuditLogs(id, connectorId, projectId, actorId, eventType, metadata, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), connectorId, projectId, actorId, eventType, cleanAuditMetadata(metadata), iso()],
  );
}

function expireConnectors(db) {
  const now = iso();
  db.run(
    `UPDATE chatgptConnectors SET status='EXPIRED', pairingCodeHash=NULL, pairingExpiresAt=NULL, updatedAt=?
     WHERE status IN ('PENDING','ACTIVE') AND expiresAt<=?`,
    [now, now],
  );
  db.run("DELETE FROM chatgptOauthRequests WHERE expiresAt<=?", [now]);
  db.run("DELETE FROM chatgptOauthCodes WHERE expiresAt<=? OR usedAt IS NOT NULL", [now]);
}

function assertConnectorOwner(connector, identity, role) {
  if (!connector) throw connectorError("CONNECTOR_NOT_FOUND", "ChatGPT connector not found", 404);
  if (role.role !== "owner" && connector.createdBy !== identity.principalId) {
    throw connectorError("CONNECTOR_FORBIDDEN", "Only the connector creator or project owner can manage this connector", 403);
  }
}

export async function createConnector(projectId, input, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const displayName = typeof input?.displayName === "string" && input.displayName.trim()
    ? input.displayName.trim().slice(0, 120)
    : "ChatGPT Web";
  const allowPlanSubmit = input?.allowPlanSubmit === true;
  const expirationDays = Number.isSafeInteger(input?.expirationDays)
    ? Math.max(1, Math.min(input.expirationDays, 365))
    : 30;
  const id = uuidv4();
  const now = Date.now();
  const pairing = createPairingCode();
  const scopes = allowPlanSubmit
    ? [...CHATGPT_CONNECTOR_READ_SCOPES, "plan.submit"]
    : [...CHATGPT_CONNECTOR_READ_SCOPES];
  const db = await getAdapter();
  db.transaction(() => {
    expireConnectors(db);
    db.run(
      `INSERT INTO chatgptConnectors(
        id, projectId, createdBy, displayName, status, allowedScopes, allowPlanSubmit,
        pairingCodeHash, pairingExpiresAt, pairingAttempts, expiresAt, createdAt, updatedAt
       ) VALUES(?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        id, projectId, identity.principalId, displayName, JSON.stringify(scopes), allowPlanSubmit ? 1 : 0,
        pairing.hash, iso(now + CHATGPT_CONNECTOR_LIMITS.pairingTtlMs),
        iso(now + expirationDays * 24 * 60 * 60_000), iso(now), iso(now),
      ],
    );
    audit(db, {
      connectorId: id,
      projectId,
      actorId: identity.principalId,
      eventType: "CONNECTOR_CREATED",
      metadata: { allowPlanSubmit, expirationDays, scopes },
    });
  });
  return { connector: parseConnector(db.get("SELECT * FROM chatgptConnectors WHERE id=?", [id])), pairingCode: pairing.display };
}

export async function listConnectors(projectId, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const db = await getAdapter();
  expireConnectors(db);
  return db.all("SELECT * FROM chatgptConnectors WHERE projectId=? ORDER BY createdAt DESC", [projectId]).map(parseConnector);
}

export async function getConnector(projectId, connectorId, identity) {
  const role = await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const db = await getAdapter();
  expireConnectors(db);
  const connector = db.get("SELECT * FROM chatgptConnectors WHERE id=? AND projectId=?", [connectorId, projectId]);
  assertConnectorOwner(connector, identity, role);
  return parseConnector(connector);
}

export async function rotatePairingCode(projectId, connectorId, identity) {
  const role = await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const db = await getAdapter();
  const current = db.get("SELECT * FROM chatgptConnectors WHERE id=? AND projectId=?", [connectorId, projectId]);
  assertConnectorOwner(current, identity, role);
  if (["REVOKED", "EXPIRED"].includes(current.status)) {
    throw connectorError("CONNECTOR_NOT_ACTIVE", "Revoked or expired connectors cannot be paired", 409);
  }
  const pairing = createPairingCode();
  const now = Date.now();
  db.transaction(() => {
    db.run(
      `UPDATE chatgptConnectors SET status='PENDING', pairingCodeHash=?, pairingExpiresAt=?, pairingAttempts=0,
       pairedAt=NULL, updatedAt=? WHERE id=?`,
      [pairing.hash, iso(now + CHATGPT_CONNECTOR_LIMITS.pairingTtlMs), iso(now), connectorId],
    );
    db.run("UPDATE chatgptOauthTokens SET revokedAt=? WHERE connectorId=? AND revokedAt IS NULL", [iso(now), connectorId]);
    audit(db, { connectorId, projectId, actorId: identity.principalId, eventType: "PAIRING_ROTATED" });
  });
  return { connector: parseConnector(db.get("SELECT * FROM chatgptConnectors WHERE id=?", [connectorId])), pairingCode: pairing.display };
}

export async function revokeConnector(projectId, connectorId, identity) {
  const role = await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const db = await getAdapter();
  const current = db.get("SELECT * FROM chatgptConnectors WHERE id=? AND projectId=?", [connectorId, projectId]);
  assertConnectorOwner(current, identity, role);
  const now = iso();
  db.transaction(() => {
    db.run(
      `UPDATE chatgptConnectors SET status='REVOKED', pairingCodeHash=NULL, pairingExpiresAt=NULL,
       revokedAt=?, updatedAt=? WHERE id=?`,
      [now, now, connectorId],
    );
    db.run("UPDATE chatgptOauthTokens SET revokedAt=? WHERE connectorId=? AND revokedAt IS NULL", [now, connectorId]);
    db.run("DELETE FROM chatgptOauthCodes WHERE connectorId=?", [connectorId]);
    audit(db, { connectorId, projectId, actorId: identity.principalId, eventType: "CONNECTOR_REVOKED" });
  });
  return parseConnector(db.get("SELECT * FROM chatgptConnectors WHERE id=?", [connectorId]));
}

export async function registerOauthClient({ clientName = null, redirectUris }) {
  const db = await getAdapter();
  const count = Number(db.get("SELECT COUNT(*) AS count FROM chatgptOauthClients")?.count || 0);
  if (count >= CHATGPT_CONNECTOR_LIMITS.maxOauthClients) {
    throw connectorError("OAUTH_CLIENT_LIMIT", "OAuth client registration limit reached", 429);
  }
  const id = `9r_cg_client_${createOpaqueToken("id").split("_").at(-1).slice(0, 20)}`;
  db.run(
    "INSERT INTO chatgptOauthClients(id, clientName, redirectUris, createdAt) VALUES(?, ?, ?, ?)",
    [id, clientName ? String(clientName).slice(0, 120) : null, JSON.stringify(redirectUris), iso()],
  );
  return { id, clientName, redirectUris };
}

export async function createOauthRequest(input) {
  const db = await getAdapter();
  expireConnectors(db);
  const client = db.get("SELECT * FROM chatgptOauthClients WHERE id=?", [input.clientId]);
  if (!client) throw connectorError("OAUTH_INVALID_CLIENT", "Unknown OAuth client", 400);
  const redirects = parseJson(client.redirectUris, []);
  if (!redirects.includes(input.redirectUri)) throw connectorError("OAUTH_REDIRECT_INVALID", "Redirect URI is not registered", 400);
  const id = uuidv4();
  const now = Date.now();
  db.run(
    `INSERT INTO chatgptOauthRequests(
      id, clientId, redirectUri, codeChallenge, requestedScopes, state, resource, expiresAt, createdAt
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, input.clientId, input.redirectUri, input.codeChallenge, JSON.stringify(input.requestedScopes),
      input.state || null, input.resource || null, iso(now + CHATGPT_CONNECTOR_LIMITS.oauthRequestTtlMs), iso(now),
    ],
  );
  return { id, clientName: client.clientName };
}

export async function authorizePairing(requestId, pairingCode) {
  const db = await getAdapter();
  const normalized = normalizePairingCode(pairingCode);
  let result = null;
  let failure = null;
  db.transaction(() => {
    expireConnectors(db);
    const request = db.get("SELECT * FROM chatgptOauthRequests WHERE id=?", [requestId]);
    if (!request) throw connectorError("OAUTH_REQUEST_EXPIRED", "Authorization request is invalid or expired", 400);
    if (Number(request.attempts || 0) >= CHATGPT_CONNECTOR_LIMITS.maxPairingAttempts) {
      db.run("DELETE FROM chatgptOauthRequests WHERE id=?", [requestId]);
      failure = connectorError("PAIRING_ATTEMPTS_EXCEEDED", "Too many pairing attempts", 429);
      return;
    }
    const connector = normalized
      ? db.get(
        `SELECT * FROM chatgptConnectors
         WHERE pairingCodeHash=? AND status='PENDING' AND pairingExpiresAt>? AND expiresAt>?`,
        [sha256(normalized), iso(), iso()],
      )
      : null;
    if (!connector) {
      db.run("UPDATE chatgptOauthRequests SET attempts=attempts+1 WHERE id=?", [requestId]);
      failure = connectorError("PAIRING_CODE_INVALID", "Pairing code is invalid or expired", 400);
      return;
    }
    const requested = parseJson(request.requestedScopes, []);
    const allowed = parseJson(connector.allowedScopes, []);
    const scopes = requested.length
      ? requested.filter((scope) => allowed.includes(scope) && CHATGPT_CONNECTOR_SCOPES.includes(scope))
      : allowed.filter((scope) => CHATGPT_CONNECTOR_SCOPES.includes(scope));
    if (!scopes.length) throw connectorError("OAUTH_SCOPE_INVALID", "No requested scope is permitted", 400);
    const rawCode = createOpaqueToken("9r_cg_ac");
    const now = Date.now();
    db.run(
      `INSERT INTO chatgptOauthCodes(
        codeHash, connectorId, projectId, clientId, redirectUri, codeChallenge, scopes, expiresAt, createdAt
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sha256(rawCode), connector.id, connector.projectId, request.clientId, request.redirectUri,
        request.codeChallenge, JSON.stringify(scopes), iso(now + CHATGPT_CONNECTOR_LIMITS.authorizationCodeTtlMs), iso(now),
      ],
    );
    db.run(
      `UPDATE chatgptConnectors SET status='ACTIVE', pairingCodeHash=NULL, pairingExpiresAt=NULL,
       pairedAt=?, updatedAt=? WHERE id=?`,
      [iso(now), iso(now), connector.id],
    );
    db.run("DELETE FROM chatgptOauthRequests WHERE id=?", [requestId]);
    audit(db, {
      connectorId: connector.id,
      projectId: connector.projectId,
      actorId: connector.createdBy,
      eventType: "CONNECTOR_PAIRED",
      metadata: { clientId: request.clientId, scopes },
    });
    result = { code: rawCode, redirectUri: request.redirectUri, state: request.state };
  });
  if (failure) throw failure;
  return result;
}

function insertToken(db, { raw, tokenType, connector, clientId, scopes, expiresAt, rotatedFromId = null }) {
  const id = uuidv4();
  db.run(
    `INSERT INTO chatgptOauthTokens(
      id, tokenHash, tokenType, connectorId, projectId, clientId, scopes, expiresAt, rotatedFromId, createdAt
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, sha256(raw), tokenType, connector.id, connector.projectId, clientId, JSON.stringify(scopes), expiresAt, rotatedFromId, iso()],
  );
  return id;
}

function issueTokenPair(db, connector, clientId, scopes, rotatedFromId = null) {
  const now = Date.now();
  const connectorExpiry = Date.parse(connector.expiresAt);
  const accessExpires = Math.min(now + CHATGPT_CONNECTOR_LIMITS.accessTokenTtlMs, connectorExpiry);
  const accessToken = createOpaqueToken("9r_cg_at");
  insertToken(db, {
    raw: accessToken,
    tokenType: "access",
    connector,
    clientId,
    scopes,
    expiresAt: iso(accessExpires),
    rotatedFromId,
  });
  let refreshToken = null;
  if (scopes.includes("offline_access")) {
    refreshToken = createOpaqueToken("9r_cg_rt");
    insertToken(db, {
      raw: refreshToken,
      tokenType: "refresh",
      connector,
      clientId,
      scopes,
      expiresAt: iso(Math.min(now + CHATGPT_CONNECTOR_LIMITS.refreshTokenTtlMs, connectorExpiry)),
      rotatedFromId,
    });
  }
  return { accessToken, refreshToken, expiresIn: Math.max(1, Math.floor((accessExpires - now) / 1000)), scopes };
}

export async function exchangeAuthorizationCode({ code, clientId, redirectUri, codeVerifier }) {
  const db = await getAdapter();
  const codeHash = sha256(code);
  const current = db.get("SELECT * FROM chatgptOauthCodes WHERE codeHash=?", [codeHash]);
  if (!current || current.usedAt || current.expiresAt <= iso()) throw connectorError("OAUTH_INVALID_GRANT", "Authorization code is invalid or expired", 400);
  if (current.clientId !== clientId || current.redirectUri !== redirectUri) throw connectorError("OAUTH_INVALID_GRANT", "Authorization code binding does not match", 400);
  if (!codeVerifier || base64UrlSha256(codeVerifier) !== current.codeChallenge) throw connectorError("OAUTH_INVALID_GRANT", "PKCE verification failed", 400);
  let tokens;
  db.transaction(() => {
    const changed = db.run("UPDATE chatgptOauthCodes SET usedAt=? WHERE codeHash=? AND usedAt IS NULL", [iso(), codeHash])?.changes || 0;
    if (!changed) throw connectorError("OAUTH_INVALID_GRANT", "Authorization code was already used", 400);
    const connector = db.get("SELECT * FROM chatgptConnectors WHERE id=?", [current.connectorId]);
    if (!connector || connector.status !== "ACTIVE" || connector.expiresAt <= iso()) {
      throw connectorError("CONNECTOR_NOT_ACTIVE", "Connector is not active", 403);
    }
    tokens = issueTokenPair(db, connector, clientId, parseJson(current.scopes, []));
    audit(db, {
      connectorId: connector.id,
      projectId: connector.projectId,
      actorId: connector.createdBy,
      eventType: "OAUTH_TOKEN_ISSUED",
      metadata: { clientId, scopes: tokens.scopes },
    });
  });
  return tokens;
}

export async function rotateRefreshToken({ refreshToken, clientId }) {
  const db = await getAdapter();
  const hash = sha256(refreshToken);
  let tokens;
  db.transaction(() => {
    const current = db.get("SELECT * FROM chatgptOauthTokens WHERE tokenHash=?", [hash]);
    if (!current || current.tokenType !== "refresh" || current.clientId !== clientId
      || current.revokedAt || current.expiresAt <= iso()) {
      throw connectorError("OAUTH_INVALID_GRANT", "Refresh token is invalid or expired", 400);
    }
    const connector = db.get("SELECT * FROM chatgptConnectors WHERE id=?", [current.connectorId]);
    if (!connector || connector.status !== "ACTIVE" || connector.expiresAt <= iso()) {
      throw connectorError("CONNECTOR_NOT_ACTIVE", "Connector is not active", 403);
    }
    const revokedAt = iso();
    const changed = db.run(
      "UPDATE chatgptOauthTokens SET revokedAt=? WHERE id=? AND revokedAt IS NULL",
      [revokedAt, current.id],
    )?.changes || 0;
    if (!changed) throw connectorError("OAUTH_INVALID_GRANT", "Refresh token replay rejected", 400);
    tokens = issueTokenPair(db, connector, clientId, parseJson(current.scopes, []), current.id);
    audit(db, {
      connectorId: connector.id,
      projectId: connector.projectId,
      actorId: connector.createdBy,
      eventType: "OAUTH_TOKEN_ROTATED",
      metadata: { clientId },
    });
  });
  return tokens;
}

export async function revokeOauthToken(rawToken) {
  const db = await getAdapter();
  const current = db.get("SELECT * FROM chatgptOauthTokens WHERE tokenHash=?", [sha256(rawToken)]);
  if (!current) return false;
  db.transaction(() => {
    db.run("UPDATE chatgptOauthTokens SET revokedAt=? WHERE id=? AND revokedAt IS NULL", [iso(), current.id]);
    const connector = db.get("SELECT createdBy FROM chatgptConnectors WHERE id=?", [current.connectorId]);
    audit(db, {
      connectorId: current.connectorId,
      projectId: current.projectId,
      actorId: connector?.createdBy || "oauth-client",
      eventType: "OAUTH_TOKEN_REVOKED",
      metadata: { tokenType: current.tokenType, clientId: current.clientId },
    });
  });
  return true;
}

export async function authenticateAccessToken(rawToken) {
  if (!rawToken) throw connectorError("MCP_UNAUTHORIZED", "Bearer authentication required", 401);
  const db = await getAdapter();
  expireConnectors(db);
  const row = db.get(
    `SELECT t.*, c.createdBy, c.displayName, c.status AS connectorStatus, c.allowPlanSubmit,
      c.allowedScopes, c.expiresAt AS connectorExpiresAt
     FROM chatgptOauthTokens t JOIN chatgptConnectors c ON c.id=t.connectorId
     WHERE t.tokenHash=?`,
    [sha256(rawToken)],
  );
  if (!row || row.tokenType !== "access" || row.revokedAt || row.expiresAt <= iso()) {
    throw connectorError("MCP_UNAUTHORIZED", "Access token is invalid or expired", 401);
  }
  if (row.connectorStatus !== "ACTIVE" || row.connectorExpiresAt <= iso()) {
    throw connectorError("MCP_FORBIDDEN", "Connector is revoked or expired", 403);
  }
  const scopes = parseJson(row.scopes, []);
  const now = iso();
  db.run("UPDATE chatgptOauthTokens SET lastUsedAt=? WHERE id=?", [now, row.id]);
  db.run("UPDATE chatgptConnectors SET lastUsedAt=?, updatedAt=? WHERE id=?", [now, now, row.connectorId]);
  return {
    tokenId: row.id,
    connectorId: row.connectorId,
    projectId: row.projectId,
    principalId: row.createdBy,
    clientId: row.clientId,
    scopes,
    expiresAt: row.expiresAt,
    allowPlanSubmit: row.allowPlanSubmit === 1,
  };
}

export function requireConnectorScope(auth, scope) {
  if (!auth?.scopes?.includes(scope)) throw connectorError("MCP_INSUFFICIENT_SCOPE", `Scope ${scope} is required`, 403);
}

export async function recordConnectorAudit(auth, eventType, metadata = {}) {
  const db = await getAdapter();
  audit(db, {
    connectorId: auth.connectorId,
    projectId: auth.projectId,
    actorId: auth.principalId,
    eventType,
    metadata,
  });
}

export async function listConnectorAudit(projectId, connectorId, identity, limit = 100) {
  await getConnector(projectId, connectorId, identity);
  const db = await getAdapter();
  return db.all(
    `SELECT id, connectorId, projectId, actorId, eventType, metadata, createdAt
     FROM chatgptConnectorAuditLogs WHERE projectId=? AND connectorId=? ORDER BY createdAt DESC LIMIT ?`,
    [projectId, connectorId, Math.max(1, Math.min(Number(limit) || 100, 500))],
  ).map((row) => ({ ...row, metadata: parseJson(row.metadata, {}) }));
}

export const __test__ = { parseConnector, parseTokenRow, expireConnectors, issueTokenPair };
