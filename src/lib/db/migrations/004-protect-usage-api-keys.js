import { sanitizeUsageDailyData, usageApiKeyStorageKey } from "@/lib/usageApiKey.js";

export default {
  version: 4,
  name: "protect-usage-api-keys",
  up(db) {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name));

    if (tables.has("usageHistory")) {
      const historyRows = db.all("SELECT id, apiKey FROM usageHistory WHERE apiKey IS NOT NULL AND apiKey <> ''");
      for (const row of historyRows) {
        const protectedKey = usageApiKeyStorageKey(row.apiKey);
        if (protectedKey && protectedKey !== row.apiKey) {
          db.run("UPDATE usageHistory SET apiKey=? WHERE id=?", [protectedKey, row.id]);
        }
      }
    }

    if (tables.has("usageDaily")) {
      const dailyRows = db.all("SELECT dateKey, data FROM usageDaily");
      for (const row of dailyRows) {
        let parsed;
        try { parsed = JSON.parse(row.data); } catch { continue; }
        const sanitized = sanitizeUsageDailyData(parsed);
        const next = JSON.stringify(sanitized);
        if (next !== row.data) db.run("UPDATE usageDaily SET data=? WHERE dateKey=?", [next, row.dateKey]);
      }
    }
  },
};
