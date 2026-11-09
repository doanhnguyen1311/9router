import { getAdapter } from "@/lib/db/driver.js";
import { requireProjectRole } from "./repository.js";
import { graphStats } from "./graphRepository.js";
import { queueStats } from "./queue.js";

export async function getProjectAnalytics(projectId, principalId) {
  await requireProjectRole(projectId, principalId);
  const db = await getAdapter();
  const memoryByType = db.all("SELECT memoryType, status, COUNT(*) AS count FROM memoryItems WHERE projectId=? GROUP BY memoryType, status", [projectId]);
  const memoryBySource = db.all("SELECT sourceType, COUNT(*) AS count FROM memoryItems WHERE projectId=? GROUP BY sourceType", [projectId]);
  const filesByStatus = db.all("SELECT indexingStatus, COUNT(*) AS count, COALESCE(SUM(fileSize),0) AS bytes FROM projectFiles WHERE projectId=? GROUP BY indexingStatus", [projectId]);
  const usage = db.get(
    `SELECT COUNT(*) AS operations, COALESCE(AVG(durationMs),0) AS averageDurationMs,
      COALESCE(MAX(durationMs),0) AS maxDurationMs, COALESCE(SUM(tokenEstimate),0) AS contextTokens
     FROM memoryUsage WHERE projectId=?`,
    [projectId],
  );
  const extraction = db.get(
    `SELECT COUNT(*) AS events,
      SUM(CASE WHEN processedAt IS NOT NULL THEN 1 ELSE 0 END) AS processed
     FROM memoryEvents WHERE projectId=?`,
    [projectId],
  );
  return {
    memoryByType: memoryByType.map((row) => ({ ...row, count: Number(row.count) })),
    memoryBySource: memoryBySource.map((row) => ({ ...row, count: Number(row.count) })),
    filesByStatus: filesByStatus.map((row) => ({ ...row, count: Number(row.count), bytes: Number(row.bytes) })),
    graph: await graphStats(projectId),
    queue: await queueStats(projectId),
    retrieval: {
      operations: Number(usage?.operations || 0),
      averageDurationMs: Number(usage?.averageDurationMs || 0),
      maxDurationMs: Number(usage?.maxDurationMs || 0),
      contextTokens: Number(usage?.contextTokens || 0),
    },
    extraction: { events: Number(extraction?.events || 0), processed: Number(extraction?.processed || 0) },
  };
}
