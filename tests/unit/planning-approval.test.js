import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEY_PLANNING_DEFAULT,
  keyPlanningFromColumns,
  validateKeyPlanningInput,
} from "../../src/shared/utils/keyPlanning.js";

vi.mock("@/shared/components", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({ children, ...props }) => ReactModule.createElement("button", props, children),
    Card: ({ children }) => ReactModule.createElement("section", null, children),
  };
});

let PlanOptionCard;
let PlanStatusBadge;

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const owner = { principalId: "local-admin", displayName: "Local Admin", admin: true };

const output = {
  interpretedObjective: "Approve a project-scoped implementation plan",
  assumptions: ["Approval remains separate from execution"],
  missingInformation: [],
  constraints: ["Do not execute in Phase 2"],
  affectedModules: ["src/lib/planning"],
  risks: [],
  options: [{
    name: "Atomic approval",
    summary: "Persist an explicit approval decision",
    architecture: "Planning and approval remain isolated from execution.",
    implementationSteps: ["Validate version", "Commit one decision"],
    filesAffected: ["src/lib/planning/repository.js"],
    pros: ["Replay resistant"],
    cons: ["Requires an explicit UI action"],
    risks: [],
    complexity: "medium",
    compatibility: "Legacy keys remain OFF.",
    acceptanceCriteria: ["Only one approval wins"],
    testStrategy: ["Concurrent approval test"],
  }],
  recommendedOptionIndex: 0,
};

const provider = {
  validateCapabilities: vi.fn(async () => ({ structuredOutput: true })),
  generatePlan: vi.fn(async () => ({ plan: output, usage: {}, attempts: 1 })),
  revisePlan: vi.fn(async () => ({ plan: output, usage: {}, attempts: 1 })),
};

beforeAll(async () => {
  ({ PlanOptionCard, PlanStatusBadge } = await import("../../src/app/(dashboard)/dashboard/projects/[id]/ProjectPlanningPanel.jsx"));
});

afterAll(() => vi.doUnmock("@/shared/components"));

async function boot() {
  delete global._dbAdapter;
  delete global._projectMemoryWorker;
  vi.resetModules();
  const database = await import("@/lib/db/index.js");
  const projects = await import("@/lib/projectMemory/repository.js");
  const planning = await import("@/lib/planning/service.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  return { database, projects, planning, adapter: await getAdapter() };
}

async function pendingPlan(planning, projectId) {
  let plan = await planning.createPlan(projectId, {
    originalRequest: "Prepare an approval test",
    providerId: "test-provider",
    modelId: "test-model",
  }, owner, { provider });
  plan = await planning.selectOption(projectId, plan.id, {
    expectedVersion: plan.version,
    optionId: plan.options[0].id,
  }, owner);
  plan = await planning.requestApproval(projectId, plan.id, { expectedVersion: plan.version }, owner);
  return planning.getPlan(projectId, plan.id, owner);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-approval-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  if (global._projectMemoryWorker?.timer) clearTimeout(global._projectMemoryWorker.timer);
  delete global._projectMemoryWorker;
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("API key Planning configuration", () => {
  it("defaults old and new keys to OFF and validates the complete managed configuration", async () => {
    const { database } = await boot();
    const key = await database.createApiKey("Planning key", "machine-planning");
    expect(key.planning).toMatchObject(KEY_PLANNING_DEFAULT);

    const enabled = {
      planningEnabled: true,
      planningMode: "ADAPTIVE",
      planningProviderId: "openai",
      planningModelId: "planner-model",
      approvalRequired: true,
      contextTokenBudget: 2048,
      planExpiration: 1440,
      failurePolicy: "FAIL_CLOSED",
    };
    expect(validateKeyPlanningInput(enabled)).toMatchObject({ ok: true, value: enabled });
    const updated = await database.updateApiKey(key.id, { planning: enabled });
    expect(updated.planning).toMatchObject(enabled);
    expect((await database.getApiKeyById(key.id)).planning).toMatchObject(enabled);
    expect(validateKeyPlanningInput({ ...enabled, planningMode: "OFF" })).toMatchObject({ ok: false });
    expect(validateKeyPlanningInput({ ...enabled, contextTokenBudget: 20000 })).toMatchObject({ ok: false });
    expect(keyPlanningFromColumns({ planningEnabled: 1, planningMode: "CORRUPT" })).toMatchObject({ planningEnabled: false, planningMode: "OFF" });

    const exported = await database.exportDb();
    expect(exported.apiKeys[0].planning).toMatchObject(enabled);
  });
});

describe("Human approval state machine", () => {
  it("commits exactly one concurrent approval and stores no plaintext replay token", async () => {
    const { database, projects, planning, adapter } = await boot();
    const project = await projects.createProject({ name: "Approval race" }, owner);
    const plan = await pendingPlan(planning, project.id);
    const optionId = plan.selectedOptionId;
    const race = await Promise.allSettled([
      planning.approvePlan(project.id, plan.id, {
        expectedVersion: plan.version, optionId, scope: "EXECUTE_APPROVED_PLAN",
        idempotencyKey: "approval-race-nonce-00000001",
      }, owner),
      planning.approvePlan(project.id, plan.id, {
        expectedVersion: plan.version, optionId, scope: "EXECUTE_APPROVED_PLAN",
        idempotencyKey: "approval-race-nonce-00000002",
      }, owner),
    ]);
    expect(race.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((item) => item.status === "rejected")[0].reason.status).toBe(409);

    const approved = await planning.getPlan(project.id, plan.id, owner);
    expect(approved).toMatchObject({ status: "APPROVED", version: plan.version + 1 });
    expect(approved.approval).toMatchObject({
      decision: "APPROVED", revision: plan.currentRevision, optionId,
      actorId: owner.principalId, scope: "EXECUTE_APPROVED_PLAN",
    });
    expect(approved.approval).not.toHaveProperty("nonceHash");
    const raw = adapter.get("SELECT nonceHash FROM planApprovals WHERE planId=?", [plan.id]);
    expect(raw.nonceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(raw.nonceHash).not.toContain("approval-race-nonce");
    expect(adapter.get("SELECT COUNT(*) AS count FROM planApprovals WHERE planId=?", [plan.id]).count).toBe(1);
    expect(adapter.get("SELECT name FROM sqlite_master WHERE type='table' AND name='planExecutions'")).toBeUndefined();

    const backup = await database.exportDb();
    expect(backup.projectMemory.planApprovals).toHaveLength(1);
    await database.importDb(backup);
    const restored = await planning.getPlan(project.id, plan.id, owner);
    expect(restored.approval).toMatchObject({ decision: "APPROVED", optionId });
    expect(adapter.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("enforces writer RBAC, option/version/scope checks, replay protection, and rejection", async () => {
    const { projects, planning, adapter } = await boot();
    const project = await projects.createProject({ name: "Approval security" }, owner);
    const viewer = { principalId: "user:viewer", displayName: "Viewer", admin: false };
    await projects.upsertProjectMember(project.id, { principalId: viewer.principalId, role: "viewer" }, owner);
    let plan = await pendingPlan(planning, project.id);

    await expect(planning.approvePlan(project.id, plan.id, {
      expectedVersion: plan.version, optionId: plan.selectedOptionId,
      scope: "EXECUTE_APPROVED_PLAN", idempotencyKey: "viewer-cannot-approve-0001",
    }, viewer)).rejects.toMatchObject({ status: 403 });
    await expect(planning.approvePlan(project.id, plan.id, {
      expectedVersion: plan.version, optionId: plan.selectedOptionId,
      scope: "READ_ONLY", idempotencyKey: "invalid-scope-nonce-0001",
    }, owner)).rejects.toMatchObject({ code: "PLAN_APPROVAL_SCOPE_INVALID", status: 400 });
    await expect(planning.approvePlan(project.id, plan.id, {
      expectedVersion: plan.version, optionId: "other-option",
      scope: "EXECUTE_APPROVED_PLAN", idempotencyKey: "invalid-option-nonce-001",
    }, owner)).rejects.toMatchObject({ code: "PLAN_OPTION_INVALID", status: 409 });

    const replayKey = "replay-protected-nonce-000001";
    await planning.rejectPlan(project.id, plan.id, {
      expectedVersion: plan.version, optionId: plan.selectedOptionId,
      scope: "EXECUTE_APPROVED_PLAN", idempotencyKey: replayKey, reason: "Needs changes",
    }, owner);
    plan = await pendingPlan(planning, project.id);
    await expect(planning.approvePlan(project.id, plan.id, {
      expectedVersion: plan.version, optionId: plan.selectedOptionId,
      scope: "EXECUTE_APPROVED_PLAN", idempotencyKey: replayKey,
    }, owner)).rejects.toMatchObject({ code: "PLAN_APPROVAL_REPLAY", status: 409 });
    expect(adapter.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});

describe("Planning dashboard components", () => {
  it("renders accessible status and option controls with real plan fields", () => {
    const statusHtml = renderToStaticMarkup(React.createElement(PlanStatusBadge, { status: "PENDING_APPROVAL" }));
    expect(statusHtml).toContain("PENDING APPROVAL");
    const optionHtml = renderToStaticMarkup(React.createElement(PlanOptionCard, {
      option: { ...output.options[0], id: "option-1", recommended: true },
      selected: false,
      disabled: false,
      onSelect: () => {},
    }));
    expect(optionHtml).toContain("Atomic approval");
    expect(optionHtml).toContain("Recommended");
    expect(optionHtml).toContain("Select");
  });
});
