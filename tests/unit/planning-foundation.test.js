import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterPlanningProvider } from "../../src/lib/planning/routerProvider.js";
import { parsePlanningOutput, validatePlanningOutput } from "../../src/lib/planning/schema.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const owner = { principalId: "local-admin", displayName: "Local Admin", admin: true };

function planOutput(suffix = "") {
  return {
    interpretedObjective: `Implement project-aware planning${suffix}`,
    assumptions: ["SQLite remains the durable store"],
    missingInformation: [],
    constraints: ["Keep old API keys compatible"],
    affectedModules: ["src/lib/planning"],
    risks: [{ severity: "medium", description: "Concurrent updates", mitigation: "Use optimistic concurrency" }],
    options: [{
      name: `Additive planning backend${suffix}`,
      summary: "Add isolated planning services and APIs",
      architecture: "Planning, persistence, and provider layers remain separate.",
      implementationSteps: ["Add schema", "Add service", "Run tests"],
      filesAffected: ["src/lib/planning/service.js"],
      pros: ["Backward compatible"],
      cons: ["Adds migrations"],
      risks: ["Provider output may be invalid"],
      complexity: "medium",
      compatibility: "Planning is opt-in and old request paths are unchanged.",
      acceptanceCriteria: ["Plan survives restart"],
      testStrategy: ["Unit and integration tests"],
    }],
    recommendedOptionIndex: 0,
  };
}

function fakeProvider({ initial = planOutput(), revised = planOutput(" revised"), onGenerate = null } = {}) {
  return {
    validateCapabilities: vi.fn(async () => ({ structuredOutput: true })),
    generatePlan: vi.fn(async (input) => {
      onGenerate?.(input);
      return { plan: initial, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, attempts: 1 };
    }),
    revisePlan: vi.fn(async () => ({ plan: revised, usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180 }, attempts: 1 })),
    healthCheck: vi.fn(async () => ({ ok: true })),
  };
}

async function boot() {
  delete global._dbAdapter;
  delete global._projectMemoryWorker;
  vi.resetModules();
  const database = await import("@/lib/db/index.js");
  const projects = await import("@/lib/projectMemory/repository.js");
  const memories = await import("@/lib/projectMemory/memoryRepository.js");
  const planning = await import("@/lib/planning/service.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  return { database, projects, memories, planning, adapter: await getAdapter() };
}

function stopWorkers() {
  if (global._projectMemoryWorker?.timer) clearTimeout(global._projectMemoryWorker.timer);
  delete global._projectMemoryWorker;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-planning-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  stopWorkers();
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Planning structured provider contract", () => {
  it("strictly validates the structured plan schema", () => {
    expect(validatePlanningOutput(planOutput()).ok).toBe(true);
    expect(validatePlanningOutput({ ...planOutput(), unexpected: true })).toMatchObject({ ok: false });
    const redacted = validatePlanningOutput({ ...planOutput(), interpretedObjective: "Do not echo sk-abcdefghijklmnopqrstuvwx" });
    expect(redacted.value.interpretedObjective).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(validatePlanningOutput({ ...planOutput(), recommendedOptionIndex: 9 })).toMatchObject({ ok: false });
    expect(parsePlanningOutput("```json\n" + JSON.stringify(planOutput()) + "\n```").ok).toBe(true);
    expect(parsePlanningOutput("not-json")).toMatchObject({ ok: false, errors: ["provider output is not valid JSON"] });
  });

  it("retries invalid output on the same explicit provider/model and records usage", async () => {
    let calls = 0;
    const provider = new RouterPlanningProvider({
      maxAttempts: 2,
      invokeModel: vi.fn(async ({ providerId, modelId }) => {
        calls += 1;
        expect(`${providerId}/${modelId}`).toBe("openai/gpt-5");
        const content = calls === 1 ? "invalid" : JSON.stringify(planOutput());
        return new Response(JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    });
    const result = await provider.generatePlan({
      providerId: "openai",
      modelId: "gpt-5",
      originalRequest: "Add planning",
      context: { content: "" },
      timeoutMs: 1000,
    });
    expect(result.attempts).toBe(2);
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
  });

  it("propagates cancellation and timeout to provider work", async () => {
    const provider = new RouterPlanningProvider({
      maxAttempts: 1,
      invokeModel: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason || new Error("aborted")), { once: true });
      }),
    });
    await expect(provider.generatePlan({
      providerId: "openai", modelId: "gpt-5", originalRequest: "Wait", context: {}, timeoutMs: 20,
    })).rejects.toMatchObject({ code: "PLANNING_TIMEOUT", status: 504 });

    const controller = new AbortController();
    controller.abort();
    await expect(provider.generatePlan({
      providerId: "openai", modelId: "gpt-5", originalRequest: "Cancel", context: {}, signal: controller.signal,
    })).rejects.toMatchObject({ code: "PLANNING_CANCELLED", status: 499 });

    const external = new AbortController();
    const stream = createStreamController({ provider: "test", model: "test", signal: external.signal });
    external.abort();
    expect(stream.signal.aborted).toBe(true);
  });
});

describe("Planning persistence, RBAC, isolation, and state machine", () => {
  it("creates, revises, audits, and recovers plans without cross-project context", async () => {
    const { database, projects, memories, planning, adapter } = await boot();
    const project = await projects.createProject({ name: "Planning A" }, owner);
    const other = await projects.createProject({ name: "Planning B" }, owner);
    const rawSecret = "sk-abcdefghijklmnopqrstuvwx";
    await memories.createManualMemory(project.id, {
      memoryType: "constraint", subject: "Planning database", value: `Use SQLite WAL. Token ${rawSecret}`, pinned: true,
    }, owner);
    await memories.createManualMemory(other.id, {
      memoryType: "constraint", subject: "Planning database", value: "Use RemoteOnlyDB",
    }, owner);
    const indexedAt = new Date().toISOString();
    adapter.run(
      `INSERT INTO projectFiles(id, projectId, relativePath, fileName, language, contentHash, fileSize, indexingStatus, redactedContent, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, 'indexed', ?, ?, ?)`,
      ["planning-file-a", project.id, "src/planning/database.js", "database.js", "JavaScript", "hash-a", 120, "export function PlanningDatabase() {}", indexedAt, indexedAt],
    );
    adapter.run(
      `INSERT INTO projectFiles(id, projectId, relativePath, fileName, language, contentHash, fileSize, indexingStatus, redactedContent, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, 'indexed', ?, ?, ?)`,
      ["planning-file-b", project.id, "src/planning/schema.js", "schema.js", "JavaScript", "hash-b", 80, "export const PlanningSchema = {};", indexedAt, indexedAt],
    );
    adapter.run(
      `INSERT INTO projectSymbols(id, projectId, fileId, symbolType, name, lineStart, lineEnd, signature, createdAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["planning-symbol", project.id, "planning-file-a", "function", "PlanningDatabase", 1, 1, "function PlanningDatabase()", indexedAt],
    );
    adapter.run(
      `INSERT INTO projectFileDependencies(id, projectId, sourceFileId, targetFileId, targetReference, relationType, evidenceType, confidence, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ["planning-dependency", project.id, "planning-file-a", "planning-file-b", "./schema.js", "IMPORTS", "static-parser", indexedAt, indexedAt],
    );

    let capturedContext;
    const provider = fakeProvider({ onGenerate: (input) => { capturedContext = input.context.content; } });
    let plan = await planning.createPlan(project.id, {
      originalRequest: `Plan the planning database safely with ${rawSecret}`,
      providerId: "openai",
      modelId: "gpt-5",
      contextTokenBudget: 900,
      expirationMinutes: 60,
    }, owner, { provider });

    expect(plan).toMatchObject({ status: "OPTIONS_READY", version: 2, currentRevision: 1 });
    expect(plan.options).toHaveLength(1);
    expect(plan.originalRequest).not.toContain(rawSecret);
    expect(capturedContext).toContain("SQLite WAL");
    expect(capturedContext).toContain("PlanningDatabase");
    expect(capturedContext).toContain("src/planning/schema.js");
    expect(capturedContext).not.toContain(rawSecret);
    expect(capturedContext).not.toContain("RemoteOnlyDB");
    expect(adapter.get("SELECT snapshotType FROM contextSnapshots WHERE id=?", [plan.contextSnapshotId]).snapshotType).toBe("planning");
    expect(adapter.get("SELECT COUNT(*) AS count FROM planAuditLogs WHERE planId=?", [plan.id]).count).toBe(2);
    expect(adapter.all("PRAGMA foreign_key_check")).toEqual([]);

    const version = plan.version;
    const optionId = plan.options[0].id;
    const concurrent = await Promise.allSettled([
      planning.selectOption(project.id, plan.id, { optionId, expectedVersion: version }, owner),
      planning.selectOption(project.id, plan.id, { optionId, expectedVersion: version }, owner),
    ]);
    expect(concurrent.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((item) => item.status === "rejected")[0].reason).toMatchObject({ code: "PLAN_VERSION_CONFLICT" });

    plan = await planning.getPlan(project.id, plan.id, owner);
    plan = await planning.requestApproval(project.id, plan.id, { expectedVersion: plan.version }, owner);
    expect(plan.status).toBe("PENDING_APPROVAL");
    const revisionVersion = plan.version;
    const revisionRace = await Promise.allSettled([
      planning.revisePlan(project.id, plan.id, {
        expectedVersion: revisionVersion,
        feedback: "Keep the migration additive",
      }, owner, { provider }),
      planning.revisePlan(project.id, plan.id, {
        expectedVersion: revisionVersion,
        feedback: "Keep the migration additive",
      }, owner, { provider }),
    ]);
    expect(revisionRace.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(revisionRace.filter((item) => item.status === "rejected")[0].reason)
      .toMatchObject({ code: "PLAN_VERSION_CONFLICT" });
    plan = revisionRace.find((item) => item.status === "fulfilled").value;
    expect(plan).toMatchObject({ status: "OPTIONS_READY", currentRevision: 2 });
    expect(plan.revisions).toHaveLength(2);
    expect(plan.revisions[0].feedback).toBe("Keep the migration additive");
    expect(plan.revisions[0].usage).toMatchObject({ inputTokens: 120, outputTokens: 60, totalTokens: 180, attempts: 1 });

    const exported = await database.exportDb();
    expect(exported.projectMemory.executionPlans).toHaveLength(1);
    expect(exported.projectMemory.planRevisions).toHaveLength(2);

    const planId = plan.id;
    adapter.close?.();
    delete global._dbAdapter;
    vi.resetModules();
    const restartedPlanning = await import("@/lib/planning/service.js");
    const recovered = await restartedPlanning.getPlan(project.id, planId, owner);
    expect(recovered).toMatchObject({ id: planId, currentRevision: 2, status: "OPTIONS_READY" });
    expect(recovered.auditLog.length).toBeGreaterThanOrEqual(5);
  });

  it("requires clarification, enforces writer RBAC, and isolates plan reads", async () => {
    const { projects, planning } = await boot();
    const project = await projects.createProject({ name: "Clarification" }, owner);
    const other = await projects.createProject({ name: "Other plans" }, owner);
    const viewer = { principalId: "user:viewer", displayName: "Viewer", admin: false };
    await projects.upsertProjectMember(project.id, { principalId: viewer.principalId, role: "viewer" }, owner);
    const needsInfo = {
      ...planOutput(),
      missingInformation: [{ question: "Which deployment target?", reason: "It changes the design", required: true }],
      options: [],
      recommendedOptionIndex: null,
    };
    const provider = fakeProvider({ initial: needsInfo });
    const plan = await planning.createPlan(project.id, {
      originalRequest: "Plan deployment", providerId: "openai", modelId: "gpt-5",
    }, owner, { provider });
    expect(plan.status).toBe("NEEDS_CLARIFICATION");
    await expect(planning.createPlan(project.id, {
      originalRequest: "Viewer attempt", providerId: "openai", modelId: "gpt-5",
    }, viewer, { provider })).rejects.toMatchObject({ code: "PROJECT_FORBIDDEN", status: 403 });
    await expect(planning.getPlan(other.id, plan.id, owner)).rejects.toMatchObject({ code: "PLAN_NOT_FOUND", status: 404 });
    await expect(planning.cancelPlan(project.id, plan.id, { expectedVersion: plan.version }, viewer))
      .rejects.toMatchObject({ code: "PROJECT_FORBIDDEN", status: 403 });
  });

  it("marks initial provider failures durably without inventing a successful plan", async () => {
    const { projects, planning, adapter } = await boot();
    const project = await projects.createProject({ name: "Failure" }, owner);
    const provider = fakeProvider();
    provider.generatePlan.mockRejectedValue(Object.assign(new Error("upstream unavailable"), { code: "PLANNING_UPSTREAM_ERROR", status: 502 }));
    await expect(planning.createPlan(project.id, {
      originalRequest: "Plan safely", providerId: "openai", modelId: "gpt-5",
    }, owner, { provider })).rejects.toMatchObject({ code: "PLANNING_UPSTREAM_ERROR" });
    const failed = adapter.get("SELECT status, errorCode FROM executionPlans WHERE projectId=?", [project.id]);
    expect(failed).toMatchObject({ status: "FAILED", errorCode: "PLANNING_UPSTREAM_ERROR" });
    expect(adapter.get("SELECT COUNT(*) AS count FROM planRevisions WHERE planId=(SELECT id FROM executionPlans WHERE projectId=?)", [project.id]).count).toBe(0);
  });

  it("expires stale plans atomically before any later mutation", async () => {
    const { projects, planning, adapter } = await boot();
    const project = await projects.createProject({ name: "Expiry" }, owner);
    const plan = await planning.createPlan(project.id, {
      originalRequest: "Plan before expiry", providerId: "openai", modelId: "gpt-5",
    }, owner, { provider: fakeProvider() });
    adapter.run("UPDATE executionPlans SET expiresAt=? WHERE id=?", ["2000-01-01T00:00:00.000Z", plan.id]);
    const listed = await planning.listPlans(project.id, owner);
    expect(listed[0]).toMatchObject({ status: "EXPIRED", version: plan.version + 1 });
    await expect(planning.cancelPlan(project.id, plan.id, { expectedVersion: plan.version }, owner))
      .rejects.toMatchObject({ code: "PLAN_VERSION_CONFLICT", status: 409 });
    expect(adapter.get("SELECT COUNT(*) AS count FROM planAuditLogs WHERE planId=? AND eventType='PLAN_EXPIRED'", [plan.id]).count).toBe(1);
  });

  it("backs up and restores a selected-option foreign-key cycle atomically", async () => {
    const { database, projects, planning, adapter } = await boot();
    const project = await projects.createProject({ name: "Planning backup" }, owner);
    let plan = await planning.createPlan(project.id, {
      originalRequest: "Back up the selected plan", providerId: "openai", modelId: "gpt-5",
    }, owner, { provider: fakeProvider() });
    plan = await planning.selectOption(project.id, plan.id, {
      optionId: plan.options[0].id,
      expectedVersion: plan.version,
    }, owner);
    const dump = await database.exportDb();
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-planning-backup-"));
    const { backupDbLite } = await import("@/lib/db/backup.js");
    const backupPath = backupDbLite(adapter, backupDir);
    const Database = (await import("better-sqlite3")).default;
    const backup = new Database(backupPath);
    try {
      expect(backup.prepare("SELECT selectedOptionId FROM executionPlans WHERE id=?").get(plan.id).selectedOptionId)
        .toBe(plan.selectedOptionId);
      expect(backup.pragma("foreign_key_check")).toEqual([]);
    } finally {
      backup.close();
      fs.rmSync(backupDir, { recursive: true, force: true });
    }

    adapter.run("DELETE FROM projects");
    await database.importDb(dump);
    expect(adapter.get("SELECT selectedOptionId FROM executionPlans WHERE id=?", [plan.id]).selectedOptionId)
      .toBe(plan.selectedOptionId);
    expect(adapter.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
