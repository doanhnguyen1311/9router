import { v4 as uuidv4 } from "uuid";
import fs from "node:fs";
import path from "node:path";
import { getAdapter } from "@/lib/db/driver.js";
import { DATA_DIR } from "@/lib/dataDir.js";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol.js";
import {
  PROJECT_DEFAULTS,
  PROJECT_ROLES,
  PROJECT_STATUSES,
  isProjectAdminPrincipal,
  intInRange,
  normalizeDescription,
  normalizePrincipal,
  normalizeProjectName,
  projectNameKey,
} from "./config.js";
import { hashApiKey } from "@/lib/apiKeyStorage.js";
import { notifyApiKeysChanged } from "@/lib/apiKeyEvents.js";

const bool = (value) => value === 1 || value === true;

function projectError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function rethrowProjectConstraint(error) {
  if (error?.code === "PROJECT_LIMIT" || error?.code === "PROJECT_NAME_EXISTS") throw error;
  const message = String(error?.message || error);
  if (message.includes("PROJECT_LIMIT")) throw projectError("PROJECT_LIMIT", "Project limit reached", 409);
  if (message.includes("projects.nameKey") || message.includes("idx_projects_name_key_unique")) {
    throw projectError("PROJECT_NAME_EXISTS", "Project name already exists", 409);
  }
  throw error;
}

function systemRow(row) {
  if (!row) return null;
  return {
    enabled: bool(row.enabled),
    defaultUserAccess: bool(row.defaultUserAccess),
    extractionEnabled: bool(row.extractionEnabled),
    retrievalEnabled: bool(row.retrievalEnabled),
    fileIndexingEnabled: bool(row.fileIndexingEnabled),
    maxProjectsPerUser: row.maxProjectsPerUser,
    maxFilesPerProject: row.maxFilesPerProject,
    maxProjectBytes: row.maxProjectBytes,
    maxFileBytes: row.maxFileBytes,
    updatedAt: row.updatedAt,
  };
}

function settingsRow(row) {
  if (!row) return null;
  return {
    projectId: row.projectId,
    memoryEnabled: bool(row.memoryEnabled),
    extractionEnabled: bool(row.extractionEnabled),
    retrievalEnabled: bool(row.retrievalEnabled),
    fileIndexingEnabled: bool(row.fileIndexingEnabled),
    contextTokenBudget: row.contextTokenBudget,
    maxGraphDepth: row.maxGraphDepth,
    retainSourceContent: bool(row.retainSourceContent),
    ignoreRules: parseJson(row.ignoreRules, []),
    updatedAt: row.updatedAt,
  };
}

function projectRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    description: row.description || "",
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
    role: row.role || (row.ownerId === row.viewerPrincipal ? "owner" : null),
    stats: row.memoryCount == null ? undefined : {
      memories: Number(row.memoryCount || 0),
      entities: Number(row.entityCount || 0),
      files: Number(row.fileCount || 0),
      sessions: Number(row.sessionCount || 0),
      apiKeys: Number(row.apiKeyCount || 0),
      indexedBytes: Number(row.indexedBytes || 0),
    },
  };
}

export async function getProjectSystemSettings() {
  const db = await getAdapter();
  const row = db.get("SELECT * FROM projectSystemSettings WHERE id = 1");
  if (row) return systemRow(row);
  const now = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO projectSystemSettings(
      id, enabled, defaultUserAccess, extractionEnabled, retrievalEnabled,
      fileIndexingEnabled, maxProjectsPerUser, maxFilesPerProject,
      maxProjectBytes, maxFileBytes, updatedAt
    ) VALUES(1, 1, 1, 1, 1, 1, 50, 5000, 268435456, 10485760, ?)`,
    [now],
  );
  return systemRow(db.get("SELECT * FROM projectSystemSettings WHERE id = 1"));
}

export async function updateProjectSystemSettings(input, actor) {
  const allowed = [
    "enabled", "defaultUserAccess", "extractionEnabled", "retrievalEnabled", "fileIndexingEnabled",
    "maxProjectsPerUser", "maxFilesPerProject", "maxProjectBytes", "maxFileBytes",
  ];
  const current = await getProjectSystemSettings();
  const next = { ...current };
  for (const key of allowed) {
    if (!Object.hasOwn(input || {}, key)) continue;
    if (key.endsWith("Enabled") || key === "enabled" || key === "defaultUserAccess") {
      if (typeof input[key] !== "boolean") throw projectError("INVALID_SETTINGS", `${key} must be a boolean`);
      next[key] = input[key];
    } else {
      if (!Number.isSafeInteger(input[key]) || input[key] < 1) throw projectError("INVALID_SETTINGS", `${key} must be a positive integer`);
      next[key] = input[key];
    }
  }
  const now = new Date().toISOString();
  const db = await getAdapter();
  db.run(
    `UPDATE projectSystemSettings SET enabled=?, defaultUserAccess=?, extractionEnabled=?, retrievalEnabled=?,
      fileIndexingEnabled=?, maxProjectsPerUser=?, maxFilesPerProject=?, maxProjectBytes=?, maxFileBytes=?, updatedAt=? WHERE id=1`,
    [next.enabled ? 1 : 0, next.defaultUserAccess ? 1 : 0, next.extractionEnabled ? 1 : 0,
      next.retrievalEnabled ? 1 : 0, next.fileIndexingEnabled ? 1 : 0, next.maxProjectsPerUser,
      next.maxFilesPerProject, next.maxProjectBytes, next.maxFileBytes, now],
  );
  // Keep an audit breadcrumb without introducing another security-log subsystem.
  if (actor) db.run("INSERT OR REPLACE INTO projectPermissions(principalId, enabled, updatedBy, updatedAt) VALUES(?, COALESCE((SELECT enabled FROM projectPermissions WHERE principalId=?), 1), ?, ?)", [actor, actor, actor, now]);
  return getProjectSystemSettings();
}

export async function setUserProjectAccess(principalId, enabled, actor) {
  const normalized = normalizePrincipal(principalId);
  if (!normalized || typeof enabled !== "boolean") throw projectError("INVALID_PERMISSION", "Invalid project permission");
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO projectPermissions(principalId, enabled, updatedBy, updatedAt) VALUES(?, ?, ?, ?)
     ON CONFLICT(principalId) DO UPDATE SET enabled=excluded.enabled, updatedBy=excluded.updatedBy, updatedAt=excluded.updatedAt`,
    [normalized, enabled ? 1 : 0, actor || null, now],
  );
  return { principalId: normalized, enabled, updatedAt: now };
}

export async function getEffectiveUserProjectAccess(principalId) {
  const db = await getAdapter();
  const system = await getProjectSystemSettings();
  const row = db.get("SELECT enabled FROM projectPermissions WHERE principalId = ?", [principalId]);
  const userEnabled = row ? bool(row.enabled) : system.defaultUserAccess;
  return { system, userEnabled, effective: system.enabled && userEnabled };
}

export async function createProject({ name, description = "" }, identity, { apiKeyId = null } = {}) {
  const projectName = normalizeProjectName(name);
  const projectDescription = normalizeDescription(description);
  if (!projectName) throw projectError("INVALID_PROJECT", "Project name is required and must be at most 120 characters");
  if (projectDescription == null) throw projectError("INVALID_PROJECT", "Project description must be at most 4000 characters");
  const access = await getEffectiveUserProjectAccess(identity.principalId);
  if (!access.effective) throw projectError("PROJECT_ACCESS_DISABLED", "Project access is disabled", 403);
  const db = await getAdapter();
  const id = uuidv4();
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      if (apiKeyId) {
        const keyRow = db.get("SELECT id, projectAccess, maxProjects FROM apiKeys WHERE id=?", [apiKeyId]);
        if (!keyRow || !bool(keyRow.projectAccess)) {
          throw projectError("PROJECT_ACCESS_DISABLED", "Project access is disabled for this API key", 403);
        }
        if (keyRow.maxProjects !== null && keyRow.maxProjects !== undefined) {
          const keyLimit = Number(keyRow.maxProjects);
          const createdCount = db.get(
            "SELECT COUNT(*) AS count FROM projects WHERE createdByApiKeyId=? AND status<>'archived'",
            [apiKeyId],
          )?.count || 0;
          if (createdCount >= keyLimit) {
            throw projectError(
              "PROJECT_LIMIT",
              keyLimit === 0
                ? "Project creation is disabled for this API key (limit: 0)"
                : `Project limit reached for this API key (${createdCount}/${keyLimit})`,
              409,
            );
          }
        }
      }
      const count = db.get("SELECT COUNT(*) AS count FROM projects WHERE ownerId=? AND status<>'archived'", [identity.principalId])?.count || 0;
      const limit = db.get("SELECT maxProjectsPerUser FROM projectSystemSettings WHERE id=1")?.maxProjectsPerUser ?? access.system.maxProjectsPerUser;
      if (count >= limit) throw projectError("PROJECT_LIMIT", "Project limit reached", 409);
      db.run(
        "INSERT INTO projects(id, ownerId, createdByApiKeyId, name, nameKey, description, status, version, createdAt, updatedAt, lastActivityAt) VALUES(?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)",
        [id, identity.principalId, apiKeyId || null, projectName, projectNameKey(projectName), projectDescription, now, now, now],
      );
      if (apiKeyId) {
        db.run(
          "INSERT OR IGNORE INTO projectApiKeyMembers(projectId, apiKeyId, addedBy, addedAt) VALUES(?, ?, ?, ?)",
          [id, apiKeyId, identity.principalId, now],
        );
      }
      db.run(
        "INSERT INTO projectMembers(projectId, principalId, role, displayName, status, invitedBy, createdAt, updatedAt) VALUES(?, ?, 'owner', ?, 'active', ?, ?, ?)",
        [id, identity.principalId, identity.displayName || null, identity.principalId, now, now],
      );
      db.run(
        `INSERT INTO projectSettings(projectId, memoryEnabled, extractionEnabled, retrievalEnabled, fileIndexingEnabled,
          contextTokenBudget, maxGraphDepth, retainSourceContent, ignoreRules, updatedAt)
         VALUES(?, 1, 1, 1, 1, ?, ?, 1, '[]', ?)`,
        [id, PROJECT_DEFAULTS.contextTokenBudget, PROJECT_DEFAULTS.maxGraphDepth, now],
      );
    });
  } catch (error) {
    rethrowProjectConstraint(error);
  }
  if (apiKeyId) notifyApiKeysChanged();
  return getProjectById(id, identity.principalId);
}

const PROJECT_STATS_SQL = `
  SELECT p.*,
    CASE WHEN p.ownerId=? THEN 'owner' ELSE (SELECT role FROM projectMembers pm WHERE pm.projectId=p.id AND pm.principalId=? AND pm.status='active') END AS role,
    (SELECT COUNT(*) FROM memoryItems mi WHERE mi.projectId=p.id AND mi.status IN ('active','pinned')) AS memoryCount,
    (SELECT COUNT(*) FROM memoryEntities me WHERE me.projectId=p.id) AS entityCount,
    (SELECT COUNT(*) FROM projectFiles pf WHERE pf.projectId=p.id) AS fileCount,
    (SELECT COALESCE(SUM(fileSize),0) FROM projectFiles pf WHERE pf.projectId=p.id) AS indexedBytes,
    (SELECT COUNT(*) FROM projectSessions ps WHERE ps.projectId=p.id) AS sessionCount,
    (SELECT COUNT(*) FROM projectApiKeyMembers pam WHERE pam.projectId=p.id) AS apiKeyCount
  FROM projects p`;

export async function listProjects(principalId, { includeAll = false, search = "" } = {}) {
  const access = await getEffectiveUserProjectAccess(principalId);
  if (!access.effective) throw projectError("PROJECT_ACCESS_DISABLED", "Project access is disabled", 403);
  const db = await getAdapter();
  const where = [];
  const params = [principalId, principalId];
  if (!includeAll) {
    where.push("(p.ownerId=? OR EXISTS(SELECT 1 FROM projectMembers pm WHERE pm.projectId=p.id AND pm.principalId=? AND pm.status='active'))");
    params.push(principalId, principalId);
  }
  if (search) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')");
    const escaped = `%${String(search).slice(0, 120).replace(/[\\%_]/g, "\\$&")}%`;
    params.push(escaped, escaped);
  }
  const sql = `${PROJECT_STATS_SQL} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.updatedAt DESC LIMIT 200`;
  return db.all(sql, params).map((row) => projectRow({ ...row, viewerPrincipal: principalId }));
}

export async function getProjectRole(projectId, principalId) {
  const db = await getAdapter();
  const project = db.get("SELECT ownerId, status FROM projects WHERE id = ?", [projectId]);
  if (!project) return null;
  if (project.ownerId === principalId) return { role: "owner", projectStatus: project.status };
  const member = db.get("SELECT role, status FROM projectMembers WHERE projectId = ? AND principalId = ?", [projectId, principalId]);
  return member?.status === "active" ? { role: member.role, projectStatus: project.status } : null;
}

export async function requireProjectRole(projectId, principalId, allowed = PROJECT_ROLES, { allowLocked = false } = {}) {
  const access = await getEffectiveUserProjectAccess(principalId);
  if (!access.effective) throw projectError("PROJECT_ACCESS_DISABLED", "Project access is disabled", 403);
  const role = await getProjectRole(projectId, principalId);
  let effectiveRole = role;
  if (!effectiveRole && isProjectAdminPrincipal(principalId)) {
    const db = await getAdapter();
    const project = db.get("SELECT status FROM projects WHERE id=?", [projectId]);
    if (project) effectiveRole = { role: "owner", projectStatus: project.status, adminOverride: true };
  }
  if (!effectiveRole || !allowed.includes(effectiveRole.role)) throw projectError("PROJECT_FORBIDDEN", "You do not have access to this project", 403);
  if (effectiveRole.projectStatus === "locked" && !allowLocked && !allowed.includes("viewer")) {
    throw projectError("PROJECT_LOCKED", "Project is locked", 423);
  }
  return effectiveRole;
}

export async function getProjectById(projectId, principalId, { admin = false } = {}) {
  const db = await getAdapter();
  if (!admin) await requireProjectRole(projectId, principalId);
  const row = db.get(`${PROJECT_STATS_SQL} WHERE p.id=?`, [principalId, principalId, projectId]);
  return projectRow(row ? { ...row, viewerPrincipal: principalId } : null);
}

export async function updateProject(projectId, input, identity) {
  const role = await requireProjectRole(projectId, identity.principalId, ["owner", "editor"], { allowLocked: true });
  const db = await getAdapter();
  const current = db.get("SELECT * FROM projects WHERE id=?", [projectId]);
  if (!current) throw projectError("PROJECT_NOT_FOUND", "Project not found", 404);
  const statusChange = Object.hasOwn(input, "status") && input.status !== current.status;
  if (statusChange && role.role !== "owner") throw projectError("PROJECT_FORBIDDEN", "Only the project owner can change the project status", 403);
  if (current.status === "locked") {
    const unlockingOnly = role.role === "owner" && input.status === "active"
      && !Object.hasOwn(input, "name") && !Object.hasOwn(input, "description");
    if (!unlockingOnly) throw projectError("PROJECT_LOCKED", "Unlock the project before changing it", 423);
  }
  const name = Object.hasOwn(input, "name") ? normalizeProjectName(input.name) : current.name;
  const description = Object.hasOwn(input, "description") ? normalizeDescription(input.description) : current.description;
  const status = Object.hasOwn(input, "status") ? input.status : current.status;
  if (!name || description == null || !PROJECT_STATUSES.includes(status)) throw projectError("INVALID_PROJECT", "Invalid project update");
  const now = new Date().toISOString();
  try {
    db.run("UPDATE projects SET name=?, nameKey=?, description=?, status=?, version=version+1, updatedAt=?, lastActivityAt=? WHERE id=?", [name, projectNameKey(name), description, status, now, now, projectId]);
  } catch (error) {
    rethrowProjectConstraint(error);
  }
  return getProjectById(projectId, identity.principalId);
}

export async function deleteProject(projectId, identity, confirmation) {
  await requireProjectRole(projectId, identity.principalId, ["owner"]);
  const db = await getAdapter();
  const project = db.get("SELECT name FROM projects WHERE id=?", [projectId]);
  if (!project) return false;
  if (confirmation !== project.name && confirmation !== projectId) throw projectError("CONFIRMATION_REQUIRED", "Project name or ID confirmation is required", 400);
  const storageRoot = path.resolve(DATA_DIR, "project-memory", "files", projectId);
  const retainedFiles = db.all("SELECT storagePath FROM projectFiles WHERE projectId=? AND storagePath IS NOT NULL", [projectId]);
  let deleted = false;
  db.transaction(() => {
    try { db.run("DELETE FROM projectSearch WHERE projectId=?", [projectId]); } catch { /* FTS is optional */ }
    deleted = (db.run("DELETE FROM projects WHERE id=?", [projectId])?.changes || 0) > 0;
  });
  if (deleted) {
    for (const item of retainedFiles) {
      const filePath = path.resolve(String(item.storagePath || ""));
      if (path.dirname(filePath) !== storageRoot) continue;
      try { fs.unlinkSync(filePath); } catch { /* already absent or externally managed */ }
    }
    try { fs.rmdirSync(storageRoot); } catch { /* non-empty or already absent */ }
  }
  return deleted;
}

export async function listProjectMembers(projectId, principalId) {
  await requireProjectRole(projectId, principalId, ["owner", "editor", "viewer"]);
  const db = await getAdapter();
  return db.all("SELECT principalId, role, displayName, status, invitedBy, createdAt, updatedAt FROM projectMembers WHERE projectId=? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, createdAt", [projectId]);
}

export async function upsertProjectMember(projectId, input, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner"]);
  const principalId = normalizePrincipal(input.principalId);
  if (!principalId || !PROJECT_ROLES.includes(input.role) || input.role === "owner") throw projectError("INVALID_MEMBER", "Invalid member or role");
  const now = new Date().toISOString();
  const db = await getAdapter();
  db.run(
    `INSERT INTO projectMembers(projectId, principalId, role, displayName, status, invitedBy, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(projectId, principalId) DO UPDATE SET role=excluded.role, displayName=excluded.displayName, status='active', updatedAt=excluded.updatedAt`,
    [projectId, principalId, input.role, String(input.displayName || "").slice(0, 200) || null, identity.principalId, now, now],
  );
  return listProjectMembers(projectId, identity.principalId);
}

export async function removeProjectMember(projectId, memberPrincipalId, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner"]);
  const db = await getAdapter();
  const project = db.get("SELECT ownerId FROM projects WHERE id=?", [projectId]);
  if (project?.ownerId === memberPrincipalId) throw projectError("OWNER_REQUIRED", "Transfer ownership before removing the owner", 409);
  db.run("UPDATE projectMembers SET status='revoked', updatedAt=? WHERE projectId=? AND principalId=?", [new Date().toISOString(), projectId, memberPrincipalId]);
  return listProjectMembers(projectId, identity.principalId);
}

export async function transferProjectOwnership(projectId, newOwnerId, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner"]);
  const normalized = normalizePrincipal(newOwnerId);
  if (!normalized || normalized === identity.principalId) throw projectError("INVALID_OWNER", "Choose another active member");
  const db = await getAdapter();
  const member = db.get("SELECT status FROM projectMembers WHERE projectId=? AND principalId=?", [projectId, normalized]);
  if (member?.status !== "active") throw projectError("INVALID_OWNER", "New owner must be an active project member", 409);
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      db.run("UPDATE projects SET ownerId=?, version=version+1, updatedAt=? WHERE id=?", [normalized, now, projectId]);
      db.run("UPDATE projectMembers SET role='editor', updatedAt=? WHERE projectId=? AND principalId=?", [now, projectId, identity.principalId]);
      db.run("UPDATE projectMembers SET role='owner', updatedAt=? WHERE projectId=? AND principalId=?", [now, projectId, normalized]);
    });
  } catch (error) {
    rethrowProjectConstraint(error);
  }
  return getProjectById(projectId, normalized);
}

export async function getProjectSettings(projectId, principalId) {
  await requireProjectRole(projectId, principalId);
  const db = await getAdapter();
  return settingsRow(db.get("SELECT * FROM projectSettings WHERE projectId=?", [projectId]));
}

export async function updateProjectSettings(projectId, input, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const current = await getProjectSettings(projectId, identity.principalId);
  const next = { ...current };
  for (const key of ["memoryEnabled", "extractionEnabled", "retrievalEnabled", "fileIndexingEnabled", "retainSourceContent"]) {
    if (Object.hasOwn(input, key)) {
      if (typeof input[key] !== "boolean") throw projectError("INVALID_SETTINGS", `${key} must be a boolean`);
      next[key] = input[key];
    }
  }
  next.contextTokenBudget = intInRange(input.contextTokenBudget, 128, 16000, current.contextTokenBudget);
  next.maxGraphDepth = intInRange(input.maxGraphDepth, 1, 6, current.maxGraphDepth);
  if (Object.hasOwn(input, "ignoreRules")) {
    if (!Array.isArray(input.ignoreRules) || input.ignoreRules.length > 200 || input.ignoreRules.some((rule) => typeof rule !== "string" || rule.length > 300)) {
      throw projectError("INVALID_SETTINGS", "ignoreRules must be a list of short strings");
    }
    next.ignoreRules = [...new Set(input.ignoreRules.map((rule) => rule.trim()).filter(Boolean))];
  }
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(
    `UPDATE projectSettings SET memoryEnabled=?, extractionEnabled=?, retrievalEnabled=?, fileIndexingEnabled=?,
      contextTokenBudget=?, maxGraphDepth=?, retainSourceContent=?, ignoreRules=?, updatedAt=? WHERE projectId=?`,
    [next.memoryEnabled ? 1 : 0, next.extractionEnabled ? 1 : 0, next.retrievalEnabled ? 1 : 0,
      next.fileIndexingEnabled ? 1 : 0, next.contextTokenBudget, next.maxGraphDepth,
      next.retainSourceContent ? 1 : 0, stringifyJson(next.ignoreRules), now, projectId],
  );
  return getProjectSettings(projectId, identity.principalId);
}

export async function listAssignableProjectsForKey(keyRecord) {
  if (!keyRecord?.projectAccess || !keyRecord?.id) return [];
  const access = await getEffectiveUserProjectAccess(keyRecord.ownerId);
  if (!access.effective) return [];
  const db = await getAdapter();
  const linkedRows = db.all(
    `SELECT projectId FROM projectApiKeyMembers WHERE apiKeyId=?
     UNION
     SELECT projectId FROM projectApiKeys WHERE apiKeyId=?`,
    [keyRecord.id, keyRecord.id],
  );
  const linkedIds = new Set(linkedRows.map((r) => r.projectId));
  if (linkedIds.size === 0) return [];
  return (await listProjects(keyRecord.ownerId)).filter(
    (project) => linkedIds.has(project.id) && ["owner", "editor"].includes(project.role),
  );
}

export async function getApiKeyProjectAssignment(apiKeyId) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT pak.apiKeyId, pak.projectId, pak.assignedBy, pak.assignedAt, p.name, p.description, p.status
     FROM projectApiKeys pak JOIN projects p ON p.id=pak.projectId WHERE pak.apiKeyId=?`,
    [apiKeyId],
  );
  return row || null;
}

export async function assignApiKeyToProject(
  apiKeyId,
  projectId,
  actor,
  { selfService = false, removeFromProjectId = null, activeOnly = false } = {},
) {
  const db = await getAdapter();
  const key = db.get("SELECT id, ownerId, projectAccess FROM apiKeys WHERE id=?", [apiKeyId]);
  if (!key) throw projectError("KEY_NOT_FOUND", "API key not found", 404);
  if (projectId == null || projectId === "") {
    if (removeFromProjectId) {
      const principalId = selfService ? (key.ownerId || "local-admin") : actor?.principalId;
      if (!selfService && !actor?.admin && key.ownerId !== principalId) {
        const role = principalId ? await getProjectRole(removeFromProjectId, principalId) : null;
        if (!role || !["owner", "editor"].includes(role.role)) throw projectError("PROJECT_FORBIDDEN", "You cannot unassign this API key", 403);
      }
      db.run("DELETE FROM projectApiKeyMembers WHERE projectId=? AND apiKeyId=?", [removeFromProjectId, apiKeyId]);
      db.run("DELETE FROM projectApiKeys WHERE projectId=? AND apiKeyId=?", [removeFromProjectId, apiKeyId]);
      notifyApiKeysChanged();
      return null;
    }
    const assignment = db.get("SELECT projectId FROM projectApiKeys WHERE apiKeyId=?", [apiKeyId]);
    if (!assignment) return null;
    const principalId = selfService ? (key.ownerId || "local-admin") : actor?.principalId;
    if (!selfService && !actor?.admin && key.ownerId !== principalId) {
      const role = principalId ? await getProjectRole(assignment.projectId, principalId) : null;
      if (!role || !["owner", "editor"].includes(role.role)) throw projectError("PROJECT_FORBIDDEN", "You cannot unassign this API key", 403);
    }
    db.run("DELETE FROM projectApiKeys WHERE apiKeyId=?", [apiKeyId]);
    notifyApiKeysChanged();
    return null;
  }
  if (!bool(key.projectAccess)) throw projectError("PROJECT_ACCESS_DISABLED", "Project access is disabled for this API key", 403);
  const principalId = selfService ? (key.ownerId || "local-admin") : actor?.principalId;
  if (!selfService && !actor?.admin && key.ownerId !== principalId) throw projectError("PROJECT_FORBIDDEN", "Only the API key owner or an administrator can assign it", 403);
  await requireProjectRole(projectId, principalId, ["owner", "editor"]);
  const keyOwnerRole = await getProjectRole(projectId, key.ownerId);
  if (!keyOwnerRole || !["owner", "editor"].includes(keyOwnerRole.role)) {
    throw projectError("PROJECT_FORBIDDEN", "The API key owner cannot use this project", 403);
  }
  const access = await getEffectiveUserProjectAccess(key.ownerId || principalId);
  if (!access.effective) throw projectError("PROJECT_ACCESS_DISABLED", "Project access is disabled", 403);
  if (selfService || activeOnly) {
    const member = db.get(
      "SELECT 1 AS ok FROM projectApiKeyMembers WHERE projectId=? AND apiKeyId=?",
      [projectId, apiKeyId],
    );
    if (!member) {
      throw projectError("PROJECT_FORBIDDEN", "This API key has not been added to the selected project", 403);
    }
  }
  const now = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO projectApiKeyMembers(projectId, apiKeyId, addedBy, addedAt) VALUES(?, ?, ?, ?)`,
    [projectId, apiKeyId, principalId, now],
  );
  db.run(
    `INSERT INTO projectApiKeys(apiKeyId, projectId, assignedBy, assignedAt) VALUES(?, ?, ?, ?)
     ON CONFLICT(apiKeyId) DO UPDATE SET projectId=excluded.projectId, assignedBy=excluded.assignedBy, assignedAt=excluded.assignedAt`,
    [apiKeyId, projectId, principalId, now],
  );
  notifyApiKeysChanged();
  return getApiKeyProjectAssignment(apiKeyId);
}

export async function listProjectApiKeys(projectId, principalId) {
  await requireProjectRole(projectId, principalId);
  const db = await getAdapter();
  return db.all(
    `SELECT k.id, k.name, k.isActive, k.projectAccess, pam.addedAt AS assignedAt, pak.projectId AS activeProjectId
     FROM projectApiKeyMembers pam
     JOIN apiKeys k ON k.id=pam.apiKeyId
     LEFT JOIN projectApiKeys pak ON pak.apiKeyId=k.id
     WHERE pam.projectId=?
     ORDER BY pam.addedAt DESC`,
    [projectId],
  ).map((row) => ({
    ...row,
    isActive: bool(row.isActive),
    projectAccess: bool(row.projectAccess),
    isCurrentlyActiveProject: row.activeProjectId === projectId,
  }));
}

export async function listAssignableApiKeysForProject(projectId, principalId, admin = false) {
  const role = await requireProjectRole(projectId, principalId);
  if (!admin && !["owner", "editor"].includes(role.role)) return [];
  const db = await getAdapter();
  const ownerFilter = admin ? "" : "AND k.ownerId=?";
  const params = admin ? [projectId] : [projectId, principalId];
  return db.all(
    `SELECT k.id, k.name, k.isActive, k.projectAccess, pak.projectId AS assignedProjectId
     FROM apiKeys k
     LEFT JOIN projectApiKeys pak ON pak.apiKeyId=k.id
     LEFT JOIN projectApiKeyMembers pam ON pam.apiKeyId=k.id AND pam.projectId=?
     WHERE k.projectAccess=1 AND pam.apiKeyId IS NULL ${ownerFilter}
     ORDER BY k.createdAt ASC`,
    params,
  ).map((row) => ({ ...row, isActive: bool(row.isActive), projectAccess: bool(row.projectAccess) }));
}

export async function resolveGatewayProject(apiKeyValue) {
  if (!apiKeyValue) return null;
  const startedAt = Date.now();
  const db = await getAdapter();
  const row = db.get(
    `SELECT p.*, k.id AS apiKeyId, k.ownerId AS keyOwnerId, k.projectAccess,
      sys.enabled AS globalEnabled, sys.defaultUserAccess, sys.extractionEnabled AS globalExtraction,
      sys.retrievalEnabled AS globalRetrieval, sys.fileIndexingEnabled AS globalFileIndexing,
      perm.enabled AS userEnabled,
      ps.memoryEnabled, ps.extractionEnabled, ps.retrievalEnabled, ps.fileIndexingEnabled,
      ps.contextTokenBudget, ps.maxGraphDepth, ps.retainSourceContent, ps.ignoreRules
     FROM apiKeys k
     JOIN projectApiKeys pak ON pak.apiKeyId=k.id
     JOIN projects p ON p.id=pak.projectId
     JOIN projectSystemSettings sys ON sys.id=1
     JOIN projectSettings ps ON ps.projectId=p.id
     LEFT JOIN projectPermissions perm ON perm.principalId=k.ownerId
     WHERE (k.keyHash=? OR k.key=?) AND k.isActive=1
       AND (p.ownerId=k.ownerId OR EXISTS(
         SELECT 1 FROM projectMembers pm WHERE pm.projectId=p.id AND pm.principalId=k.ownerId
           AND pm.status='active' AND pm.role IN ('owner','editor')
       ))
     LIMIT 1`,
    [hashApiKey(apiKeyValue), apiKeyValue],
  );
  if (!row) return null;
  const userEnabled = row.userEnabled == null ? bool(row.defaultUserAccess) : bool(row.userEnabled);
  if (!bool(row.globalEnabled) || !userEnabled || !bool(row.projectAccess) || row.status !== "active" || !bool(row.memoryEnabled)) return null;
  return {
    project: projectRow(row),
    apiKeyId: row.apiKeyId,
    ownerId: row.keyOwnerId,
    resolvedAt: new Date().toISOString(),
    resolutionMs: Date.now() - startedAt,
    settings: {
      memoryEnabled: true,
      extractionEnabled: bool(row.globalExtraction) && bool(row.extractionEnabled),
      retrievalEnabled: bool(row.globalRetrieval) && bool(row.retrievalEnabled),
      fileIndexingEnabled: bool(row.globalFileIndexing) && bool(row.fileIndexingEnabled),
      contextTokenBudget: row.contextTokenBudget,
      maxGraphDepth: row.maxGraphDepth,
      retainSourceContent: bool(row.retainSourceContent),
      ignoreRules: parseJson(row.ignoreRules, []),
    },
  };
}

// Fast path used by the gateway: getApiKeyByKey already LEFT JOINs assignment,
// so ordinary unassigned keys return before any Project Memory query.
export async function resolveGatewayProjectForKeyRecord(keyRecord) {
  if (!keyRecord?.assignedProjectId || !keyRecord?.projectAccess || !keyRecord?.isActive) return null;
  const startedAt = Date.now();
  const db = await getAdapter();
  const row = db.get(
    `SELECT p.*, sys.enabled AS globalEnabled, sys.defaultUserAccess,
      sys.extractionEnabled AS globalExtraction, sys.retrievalEnabled AS globalRetrieval,
      sys.fileIndexingEnabled AS globalFileIndexing, perm.enabled AS userEnabled,
      ps.memoryEnabled, ps.extractionEnabled, ps.retrievalEnabled, ps.fileIndexingEnabled,
      ps.contextTokenBudget, ps.maxGraphDepth, ps.retainSourceContent, ps.ignoreRules
     FROM projects p
     JOIN projectSystemSettings sys ON sys.id=1
     JOIN projectSettings ps ON ps.projectId=p.id
     LEFT JOIN projectPermissions perm ON perm.principalId=?
     WHERE p.id=? AND (p.ownerId=? OR EXISTS(
       SELECT 1 FROM projectMembers pm WHERE pm.projectId=p.id AND pm.principalId=?
         AND pm.status='active' AND pm.role IN ('owner','editor')
     )) LIMIT 1`,
    [keyRecord.ownerId, keyRecord.assignedProjectId, keyRecord.ownerId, keyRecord.ownerId],
  );
  if (!row) return null;
  const userEnabled = row.userEnabled == null ? bool(row.defaultUserAccess) : bool(row.userEnabled);
  if (!bool(row.globalEnabled) || !userEnabled || row.status !== "active" || !bool(row.memoryEnabled)) return null;
  return {
    project: projectRow(row),
    apiKeyId: keyRecord.id,
    ownerId: keyRecord.ownerId,
    resolvedAt: new Date().toISOString(),
    resolutionMs: Date.now() - startedAt,
    settings: {
      memoryEnabled: true,
      extractionEnabled: bool(row.globalExtraction) && bool(row.extractionEnabled),
      retrievalEnabled: bool(row.globalRetrieval) && bool(row.retrievalEnabled),
      fileIndexingEnabled: bool(row.globalFileIndexing) && bool(row.fileIndexingEnabled),
      contextTokenBudget: row.contextTokenBudget,
      maxGraphDepth: row.maxGraphDepth,
      retainSourceContent: bool(row.retainSourceContent),
      ignoreRules: parseJson(row.ignoreRules, []),
    },
  };
}

export async function resolvePersistentSession({ projectId, apiKeyId, clientNamespace, clientSessionId }) {
  const namespace = String(clientNamespace || "generic").slice(0, 80);
  const externalId = String(clientSessionId || uuidv4()).slice(0, 256);
  const db = await getAdapter();
  const now = new Date().toISOString();
  let session;
  db.transaction(() => {
    session = db.get(
      "SELECT * FROM projectSessions WHERE projectId=? AND clientNamespace=? AND clientSessionId=?",
      [projectId, namespace, externalId],
    );
    if (session) {
      db.run("UPDATE projectSessions SET lastActivityAt=? WHERE id=?", [now, session.id]);
      session = { ...session, lastActivityAt: now };
      return;
    }
    const id = uuidv4();
    db.run(
      `INSERT INTO projectSessions(id, projectId, apiKeyId, clientNamespace, clientSessionId, sessionVersion, createdAt, lastActivityAt)
       VALUES(?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, projectId, apiKeyId || null, namespace, externalId, now, now],
    );
    session = db.get("SELECT * FROM projectSessions WHERE id=?", [id]);
  });
  return session;
}

export async function recordSessionRoute(sessionId, provider, accountId) {
  if (!sessionId) return;
  const db = await getAdapter();
  db.run(
    "UPDATE projectSessions SET provider=?, accountId=?, sessionVersion=sessionVersion+1, lastActivityAt=? WHERE id=?",
    [provider || null, accountId || null, new Date().toISOString(), sessionId],
  );
}

export async function listProjectSessions(projectId, principalId, limit = 100) {
  await requireProjectRole(projectId, principalId);
  const db = await getAdapter();
  return db.all(
    `SELECT id, apiKeyId, clientNamespace, clientSessionId, provider, accountId, sessionVersion, createdAt, lastActivityAt
     FROM projectSessions WHERE projectId=? ORDER BY lastActivityAt DESC LIMIT ?`,
    [projectId, Math.max(1, Math.min(Number(limit) || 100, 500))],
  );
}

export async function touchProject(projectId) {
  const db = await getAdapter();
  db.run("UPDATE projects SET lastActivityAt=?, updatedAt=? WHERE id=?", [new Date().toISOString(), new Date().toISOString(), projectId]);
}

export { projectError };
