import { getAdapter } from "@/lib/db/driver.js";
import {
  recordMemoryUsage,
  retrieveProjectContext,
  saveContextSnapshot,
} from "@/lib/projectMemory/retrieval.js";
import { PLAN_LIMITS, boundedInteger, planningError } from "./constants.js";

export async function buildPlanningContext({ projectId, query, tokenBudget }) {
  const db = await getAdapter();
  const project = db.get(
    `SELECT p.id, p.status, ps.contextTokenBudget, ps.maxGraphDepth, ps.memoryEnabled, ps.retrievalEnabled
     FROM projects p JOIN projectSettings ps ON ps.projectId=p.id WHERE p.id=?`,
    [projectId],
  );
  if (!project) throw planningError("PROJECT_NOT_FOUND", "Project not found", 404);
  if (project.status !== "active") throw planningError("PROJECT_NOT_ACTIVE", "Planning requires an active project", 409);
  if (project.memoryEnabled !== 1 || project.retrievalEnabled !== 1) {
    return {
      content: "",
      contentHash: null,
      tokenEstimate: 0,
      provenance: { memories: [], files: [], symbols: [], dependencies: [], entities: [] },
      snapshot: null,
      retrievalDisabled: true,
    };
  }

  const projectBudget = boundedInteger(
    Number(project.contextTokenBudget),
    PLAN_LIMITS.contextTokensMin,
    PLAN_LIMITS.contextTokensMax,
    PLAN_LIMITS.defaultContextTokens,
  );
  const requestedBudget = boundedInteger(
    Number(tokenBudget),
    PLAN_LIMITS.contextTokensMin,
    PLAN_LIMITS.contextTokensMax,
    projectBudget,
  );
  const effectiveBudget = Math.min(projectBudget, requestedBudget);
  const context = await retrieveProjectContext({
    projectId,
    query,
    tokenBudget: effectiveBudget,
    maxGraphDepth: project.maxGraphDepth,
  });
  const snapshotPayload = JSON.stringify({
    query: String(query || "").slice(0, PLAN_LIMITS.originalRequestChars),
    content: context.content,
    provenance: context.provenance,
  });
  const snapshot = await saveContextSnapshot({
    projectId,
    content: snapshotPayload,
    tokenEstimate: context.tokenEstimate,
    snapshotType: "planning",
  });
  await recordMemoryUsage({
    projectId,
    operation: "planning-retrieval",
    durationMs: context.durationMs,
    itemCount: context.memories + context.files + (context.symbols || 0) + context.dependencies + context.entities,
    tokenEstimate: context.tokenEstimate,
    status: "ok",
    metadata: { terms: context.terms.length, snapshotId: snapshot?.id || null },
  });
  return { ...context, snapshot, retrievalDisabled: false };
}
