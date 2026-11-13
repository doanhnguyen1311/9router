const migration = {
  version: 10,
  name: "planning-self-service-toggle",
  up(db) {
    const columns = db.all("PRAGMA table_info(apiKeys)").map((row) => row.name);
    if (!columns.includes("planningSelfServiceEnabled")) {
      db.exec("ALTER TABLE apiKeys ADD COLUMN planningSelfServiceEnabled INTEGER NOT NULL DEFAULT 0 CHECK (planningSelfServiceEnabled IN (0,1))");
    }
  },
};

export default migration;
