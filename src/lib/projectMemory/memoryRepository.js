import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol.js";
import { MEMORY_STATUSES, MEMORY_TYPES } from "./config.js";
import { projectError, requireProjectRole } from "./repository.js";
import { removeSearchDocumentInTransaction, removeSearchDocumentsInTransaction, upsertSearchDocumentInTransaction } from "./searchIndex.js";
import { redactProjectText } from "./privacy.js";

const SOURCE_PRIORITY = Object.freeze({ inferred: 1, "assistant-suggested": 2, "imported-file": 3, "user-confirmed": 4, "tool-verified": 5 });

function rowToMemory(row) {
  if (!row) return null;
  return {
    id: row.id, projectId: row.projectId, memoryType: row.memoryType,
    subject: row.subject, value: row.value,
    structuredContent: parseJson(row.structuredContent, {}),
    confidence: row.confidence, sourceType: row.sourceType,
    sourceSessionId: row.sourceSessionId, sourceEventId: row.sourceEventId,
    evidenceReference: row.evidenceReference, version: row.version,
    status: row.status, pinned: row.pinned === 1 || row.pinned === true,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

function historySnapshot(row) {
  return stringifyJson(rowToMemory(row));
}

export function memoryFingerprint(type, subject, value) {
  return crypto.createHash("sha256").update(`${type}|${String(subject).trim().toLowerCase()}|${String(value).trim().toLowerCase()}`).digest("hex");
}

export function upsertMemoryInTransaction(db, item) {
  const now = new Date().toISOString();
  const fingerprint = item.fingerprint || memoryFingerprint(item.memoryType, item.subject, item.value);
  const duplicate = db.get("SELECT * FROM memoryItems WHERE projectId=? AND fingerprint=?", [item.projectId, fingerprint]);
  if (duplicate) {
    const nextConfidence = Math.max(Number(duplicate.confidence) || 0, Number(item.confidence) || 0);
    db.run(
      `UPDATE memoryItems SET confidence=?, updatedAt=?, version=version+1,
        evidenceReference=COALESCE(?, evidenceReference), sourceEventId=COALESCE(?, sourceEventId), sourceSessionId=COALESCE(?, sourceSessionId)
       WHERE id=?`,
      [nextConfidence, now, item.evidenceReference || null, item.sourceEventId || null, item.sourceSessionId || null, duplicate.id],
    );
    upsertSearchDocumentInTransaction(db, { projectId: item.projectId, kind: "memory", refId: duplicate.id, title: item.subject, body: item.value });
    return { memory: rowToMemory(db.get("SELECT * FROM memoryItems WHERE id=?", [duplicate.id])), action: "deduplicated" };
  }

  const conflict = db.get(
    `SELECT * FROM memoryItems WHERE projectId=? AND memoryType=? AND lower(subject)=lower(?)
     AND status IN ('active','pinned') ORDER BY pinned DESC, updatedAt DESC LIMIT 1`,
    [item.projectId, item.memoryType, item.subject],
  );
  let status = item.status || "active";
  if (conflict) {
    const incomingPriority = SOURCE_PRIORITY[item.sourceType] || 0;
    const currentPriority = SOURCE_PRIORITY[conflict.sourceType] || 0;
    if (conflict.pinned || conflict.status === "pinned" || incomingPriority < currentPriority) {
      status = "rejected";
    } else {
      db.run("INSERT INTO memoryItemHistory(memoryId, projectId, version, snapshot, reason, createdAt) VALUES(?, ?, ?, ?, 'superseded', ?)", [conflict.id, conflict.projectId, conflict.version, historySnapshot(conflict), now]);
      db.run("UPDATE memoryItems SET status='superseded', version=version+1, updatedAt=? WHERE id=?", [now, conflict.id]);
    }
  }

  const id = uuidv4();
  db.run(
    `INSERT INTO memoryItems(id, projectId, memoryType, subject, value, structuredContent, confidence,
      sourceType, sourceSessionId, sourceEventId, evidenceReference, fingerprint, version, status, pinned, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [id, item.projectId, item.memoryType, item.subject, item.value, stringifyJson(item.structuredContent || {}),
      item.confidence ?? 0.5, item.sourceType || "inferred", item.sourceSessionId || null,
      item.sourceEventId || null, item.evidenceReference || null, fingerprint, status,
      item.pinned ? 1 : 0, now, now],
  );
  upsertSearchDocumentInTransaction(db, { projectId: item.projectId, kind: "memory", refId: id, title: item.subject, body: item.value });
  return { memory: rowToMemory(db.get("SELECT * FROM memoryItems WHERE id=?", [id])), action: status === "rejected" ? "conflict-rejected" : "created" };
}

export async function listMemories(projectId, principalId, { q = "", type = "", status = "", limit = 100, offset = 0 } = {}) {
  await requireProjectRole(projectId, principalId);
  const db = await getAdapter();
  const where = ["projectId=?"];
  const params = [projectId];
  if (MEMORY_TYPES.includes(type)) { where.push("memoryType=?"); params.push(type); }
  if (MEMORY_STATUSES.includes(status)) { where.push("status=?"); params.push(status); }
  if (q) {
    where.push("(subject LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')");
    const term = `%${String(q).slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`;
    params.push(term, term);
  }
  params.push(Math.max(1, Math.min(Number(limit) || 100, 500)), Math.max(0, Number(offset) || 0));
  const rows = db.all(`SELECT * FROM memoryItems WHERE ${where.join(" AND ")} ORDER BY pinned DESC, updatedAt DESC LIMIT ? OFFSET ?`, params);
  return rows.map(rowToMemory);
}

export async function createManualMemory(projectId, input, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  if (!MEMORY_TYPES.includes(input.memoryType) || typeof input.subject !== "string" || typeof input.value !== "string") {
    throw projectError("INVALID_MEMORY", "Invalid memory type, subject, or value");
  }
  const subject = redactProjectText(input.subject.trim().slice(0, 240));
  const value = redactProjectText(input.value.trim().slice(0, 4000));
  const item = {
    projectId, memoryType: input.memoryType, subject: subject.text,
    value: value.text, structuredContent: { ...(input.structuredContent || {}), privacyRedactions: [...subject.findings, ...value.findings] },
    confidence: 1, sourceType: "user-confirmed", evidenceReference: `dashboard:${identity.principalId}`,
    pinned: input.pinned === true, status: input.pinned ? "pinned" : "active",
  };
  if (!item.subject || !item.value) throw projectError("INVALID_MEMORY", "Subject and value are required");
  const db = await getAdapter();
  let result;
  db.transaction(() => { result = upsertMemoryInTransaction(db, item); });
  return result.memory;
}

export async function updateMemory(projectId, memoryId, input, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const current = db.get("SELECT * FROM memoryItems WHERE id=? AND projectId=?", [memoryId, projectId]);
    if (!current) return;
    const redactedSubject = Object.hasOwn(input, "subject") ? redactProjectText(String(input.subject).trim().slice(0, 240)) : { text: current.subject, findings: [] };
    const redactedValue = Object.hasOwn(input, "value") ? redactProjectText(String(input.value).trim().slice(0, 4000)) : { text: current.value, findings: [] };
    const subject = redactedSubject.text;
    const value = redactedValue.text;
    const status = Object.hasOwn(input, "status") ? input.status : current.status;
    const pinned = Object.hasOwn(input, "pinned") ? input.pinned === true : (current.pinned === 1);
    if (!subject || !value || !MEMORY_STATUSES.includes(status)) throw projectError("INVALID_MEMORY", "Invalid memory update");
    const structuredContent = input.structuredContent || parseJson(current.structuredContent, {});
    const privacyRedactions = [...new Set([
      ...(Array.isArray(structuredContent.privacyRedactions) ? structuredContent.privacyRedactions : []),
      ...redactedSubject.findings,
      ...redactedValue.findings,
    ])];
    const now = new Date().toISOString();
    db.run("INSERT INTO memoryItemHistory(memoryId, projectId, version, snapshot, reason, createdAt) VALUES(?, ?, ?, ?, 'user-edit', ?)", [memoryId, projectId, current.version, historySnapshot(current), now]);
    db.run(
      `UPDATE memoryItems SET subject=?, value=?, structuredContent=?, fingerprint=?, confidence=1,
        sourceType='user-confirmed', evidenceReference=?, status=?, pinned=?, version=version+1, updatedAt=? WHERE id=?`,
      [subject, value, stringifyJson({ ...structuredContent, privacyRedactions }),
        memoryFingerprint(current.memoryType, subject, value), `dashboard:${identity.principalId}`,
        pinned ? "pinned" : status, pinned ? 1 : 0, now, memoryId],
    );
    upsertSearchDocumentInTransaction(db, { projectId, kind: "memory", refId: memoryId, title: subject, body: value });
    result = rowToMemory(db.get("SELECT * FROM memoryItems WHERE id=?", [memoryId]));
  });
  if (!result) throw projectError("MEMORY_NOT_FOUND", "Memory not found", 404);
  return result;
}

export async function deleteMemory(projectId, memoryId, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    deleted = (db.run("DELETE FROM memoryItems WHERE id=? AND projectId=?", [memoryId, projectId])?.changes || 0) > 0;
    if (deleted) removeSearchDocumentInTransaction(db, projectId, "memory", memoryId);
  });
  return deleted;
}

export async function deleteProjectMemories(projectId, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const db = await getAdapter();
  let deleted = 0;
  db.transaction(() => {
    deleted = db.run("DELETE FROM memoryItems WHERE projectId=?", [projectId])?.changes || 0;
    removeSearchDocumentsInTransaction(db, projectId, "memory");
  });
  return deleted;
}

export async function getMemoryHistory(projectId, memoryId, principalId) {
  await requireProjectRole(projectId, principalId);
  const db = await getAdapter();
  return db.all("SELECT id, version, snapshot, reason, createdAt FROM memoryItemHistory WHERE projectId=? AND memoryId=? ORDER BY version DESC", [projectId, memoryId])
    .map((row) => ({ ...row, snapshot: parseJson(row.snapshot, {}) }));
}

export { rowToMemory };
