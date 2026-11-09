const initialized = new WeakMap();

export function ensureProjectSearch(db) {
  if (initialized.has(db)) return initialized.get(db);
  let available = false;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS projectSearch USING fts5(
      projectId UNINDEXED, kind UNINDEXED, refId UNINDEXED, title, body,
      tokenize='unicode61 remove_diacritics 2'
    )`);
    available = true;
  } catch { available = false; }
  initialized.set(db, available);
  return available;
}

export function upsertSearchDocumentInTransaction(db, { projectId, kind, refId, title, body }) {
  if (!ensureProjectSearch(db)) return false;
  db.run("DELETE FROM projectSearch WHERE projectId=? AND kind=? AND refId=?", [projectId, kind, refId]);
  db.run("INSERT INTO projectSearch(projectId, kind, refId, title, body) VALUES(?, ?, ?, ?, ?)", [projectId, kind, refId, String(title || "").slice(0, 1000), String(body || "").slice(0, 100_000)]);
  return true;
}

export function removeSearchDocumentInTransaction(db, projectId, kind, refId) {
  if (!ensureProjectSearch(db)) return false;
  db.run("DELETE FROM projectSearch WHERE projectId=? AND kind=? AND refId=?", [projectId, kind, refId]);
  return true;
}

export function searchProjectIndex(db, projectId, terms, limit = 100) {
  if (!ensureProjectSearch(db) || !Array.isArray(terms) || !terms.length) return [];
  const query = terms.map((term) => `"${String(term).replace(/"/g, '""')}"*`).join(" OR ");
  try {
    return db.all(
      `SELECT kind, refId, bm25(projectSearch) AS rank FROM projectSearch
       WHERE projectSearch MATCH ? AND projectId=? ORDER BY rank LIMIT ?`,
      [query, projectId, Math.max(1, Math.min(Number(limit) || 100, 500))],
    );
  } catch { return []; }
}
