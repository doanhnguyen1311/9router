import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol.js";
import { requireProjectRole } from "./repository.js";

const normalize = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 300);

export function upsertEntityInTransaction(db, item) {
  const normalizedName = normalize(item.name);
  if (!normalizedName) return null;
  const now = new Date().toISOString();
  let row = db.get("SELECT * FROM memoryEntities WHERE projectId=? AND entityType=? AND normalizedName=?", [item.projectId, item.entityType, normalizedName]);
  if (row) {
    db.run("UPDATE memoryEntities SET metadata=?, confidence=MAX(confidence, ?), version=version+1, updatedAt=? WHERE id=?", [stringifyJson({ ...parseJson(row.metadata, {}), ...(item.metadata || {}) }), item.confidence ?? 0.5, now, row.id]);
    return db.get("SELECT * FROM memoryEntities WHERE id=?", [row.id]);
  }
  const id = uuidv4();
  db.run(
    `INSERT INTO memoryEntities(id, projectId, entityType, name, normalizedName, metadata, sourceType, confidence, version, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, item.projectId, item.entityType || "concept", String(item.name).slice(0, 300), normalizedName,
      stringifyJson(item.metadata || {}), item.sourceType || "inferred", item.confidence ?? 0.5, now, now],
  );
  return db.get("SELECT * FROM memoryEntities WHERE id=?", [id]);
}

export function upsertRelationInTransaction(db, item) {
  if (!item.fromEntityId || !item.toEntityId || item.fromEntityId === item.toEntityId) return null;
  const now = new Date().toISOString();
  const existing = db.get(
    `SELECT * FROM memoryRelations WHERE projectId=? AND fromEntityId=? AND toEntityId=? AND relationType=? AND evidenceType=?`,
    [item.projectId, item.fromEntityId, item.toEntityId, item.relationType, item.evidenceType],
  );
  if (existing) {
    db.run("UPDATE memoryRelations SET confidence=MAX(confidence, ?), evidenceReference=COALESCE(?, evidenceReference), version=version+1, status='active', updatedAt=? WHERE id=?", [item.confidence ?? 0.5, item.evidenceReference || null, now, existing.id]);
    return db.get("SELECT * FROM memoryRelations WHERE id=?", [existing.id]);
  }
  const id = uuidv4();
  db.run(
    `INSERT INTO memoryRelations(id, projectId, fromEntityId, toEntityId, relationType, evidenceType, evidenceReference,
      confidence, version, status, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
    [id, item.projectId, item.fromEntityId, item.toEntityId, item.relationType, item.evidenceType,
      item.evidenceReference || null, item.confidence ?? 0.5, now, now],
  );
  return db.get("SELECT * FROM memoryRelations WHERE id=?", [id]);
}

export async function searchGraph(projectId, principalId, { q = "", entityId = null, depth = 1, limit = 100 } = {}) {
  await requireProjectRole(projectId, principalId);
  const db = await getAdapter();
  const cappedDepth = Math.max(1, Math.min(Number(depth) || 1, 6));
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  let seeds;
  if (entityId) seeds = db.all("SELECT * FROM memoryEntities WHERE projectId=? AND id=?", [projectId, entityId]);
  else if (q) {
    const term = `%${String(q).slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`;
    seeds = db.all("SELECT * FROM memoryEntities WHERE projectId=? AND (name LIKE ? ESCAPE '\\' OR normalizedName LIKE ? ESCAPE '\\') ORDER BY confidence DESC LIMIT ?", [projectId, term, term, Math.min(25, cappedLimit)]);
  } else seeds = db.all("SELECT * FROM memoryEntities WHERE projectId=? ORDER BY updatedAt DESC LIMIT ?", [projectId, Math.min(50, cappedLimit)]);
  const nodes = new Map(seeds.map((row) => [row.id, row]));
  const edges = new Map();
  let frontier = seeds.map((row) => row.id);
  for (let level = 0; level < cappedDepth && frontier.length && nodes.size < cappedLimit; level += 1) {
    const placeholders = frontier.map(() => "?").join(",");
    const relations = db.all(
      `SELECT * FROM memoryRelations WHERE projectId=? AND status='active' AND (fromEntityId IN (${placeholders}) OR toEntityId IN (${placeholders})) LIMIT ?`,
      [projectId, ...frontier, ...frontier, cappedLimit * 4],
    );
    const nextIds = [];
    for (const relation of relations) {
      edges.set(relation.id, relation);
      for (const id of [relation.fromEntityId, relation.toEntityId]) if (!nodes.has(id)) nextIds.push(id);
    }
    const unique = [...new Set(nextIds)].slice(0, Math.max(0, cappedLimit - nodes.size));
    if (unique.length) {
      const related = db.all(`SELECT * FROM memoryEntities WHERE projectId=? AND id IN (${unique.map(() => "?").join(",")})`, [projectId, ...unique]);
      related.forEach((row) => nodes.set(row.id, row));
    }
    frontier = unique;
  }
  return {
    nodes: [...nodes.values()].map((row) => ({ ...row, metadata: parseJson(row.metadata, {}) })),
    edges: [...edges.values()],
  };
}

export async function graphStats(projectId) {
  const db = await getAdapter();
  return {
    entities: db.get("SELECT COUNT(*) AS count FROM memoryEntities WHERE projectId=?", [projectId])?.count || 0,
    relationships: db.get("SELECT COUNT(*) AS count FROM memoryRelations WHERE projectId=? AND status='active'", [projectId])?.count || 0,
  };
}

export async function deleteProjectGraph(projectId, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const db = await getAdapter();
  return db.run("DELETE FROM memoryEntities WHERE projectId=?", [projectId])?.changes || 0;
}
