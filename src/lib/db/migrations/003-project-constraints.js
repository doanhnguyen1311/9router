function normalizedName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  return (name || "Project").slice(0, 120);
}

function suffixedName(name, number) {
  const suffix = ` (${number})`;
  return `${name.slice(0, 120 - suffix.length).trimEnd()}${suffix}`;
}

export default {
  version: 3,
  name: "project-quota-and-unique-names",
  up(db) {
    const columns = new Set(db.all("PRAGMA table_info(projects)").map((row) => row.name));
    if (!columns.has("nameKey")) db.exec("ALTER TABLE projects ADD COLUMN nameKey TEXT");

    const rows = db.all("SELECT id, name, createdAt FROM projects ORDER BY createdAt ASC, id ASC")
      .map((row) => ({ ...row, normalized: normalizedName(row.name) }));
    const reserved = new Set(rows.map((row) => row.normalized.toLowerCase()));
    const used = new Set();
    const suffixes = new Map();
    for (const row of rows) {
      let name = row.normalized;
      let key = name.toLowerCase();
      if (used.has(key)) {
        let number = suffixes.get(key) || 2;
        do {
          name = suffixedName(row.normalized, number++);
          key = name.toLowerCase();
        } while (used.has(key) || reserved.has(key));
        suffixes.set(row.normalized.toLowerCase(), number);
      }
      used.add(key);
      db.run("UPDATE projects SET name=?, nameKey=? WHERE id=?", [name, key, row.id]);
    }

    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name_key_unique ON projects(nameKey) WHERE nameKey IS NOT NULL");
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_projects_quota_insert
      BEFORE INSERT ON projects
      WHEN NEW.status <> 'archived' AND
        (SELECT COUNT(*) FROM projects WHERE ownerId=NEW.ownerId AND status <> 'archived') >=
        COALESCE((SELECT maxProjectsPerUser FROM projectSystemSettings WHERE id=1), 50)
      BEGIN SELECT RAISE(ABORT, 'PROJECT_LIMIT'); END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_projects_quota_update
      BEFORE UPDATE OF ownerId, status ON projects
      WHEN NEW.status <> 'archived' AND (OLD.status = 'archived' OR NEW.ownerId <> OLD.ownerId) AND
        (SELECT COUNT(*) FROM projects WHERE ownerId=NEW.ownerId AND status <> 'archived' AND id <> OLD.id) >=
        COALESCE((SELECT maxProjectsPerUser FROM projectSystemSettings WHERE id=1), 50)
      BEGIN SELECT RAISE(ABORT, 'PROJECT_LIMIT'); END`);
  },
};
