import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
let workspaceRoot;
const originals = {
  dataDir: process.env.DATA_DIR,
  ticket: process.env.EXECUTION_TICKET_SECRET,
  worker: process.env.EXECUTION_WORKER_SECRET,
  roots: process.env.EXECUTION_WORKSPACE_ROOTS,
};
const owner = { principalId: "local-admin", displayName: "Local Admin", admin: true };

const output = {
  interpretedObjective: "Execute the approved API-Key planning session",
  assumptions: [],
  missingInformation: [],
  constraints: ["Stay inside the validated workspace"],
  affectedModules: ["src/example.js"],
  risks: [],
  options: [{
    name: "Local Codex worker",
    summary: "Prepare a scoped ticket for the local worker.",
    architecture: "Planning session delegates to the existing execution pipeline.",
    implementationSteps: ["Snapshot", "Claim", "Execute", "Report"],
    filesAffected: ["src/example.js"],
    pros: ["Validated handoff"],
    cons: ["Requires a local worker"],
    risks: [],
    complexity: "medium",
    compatibility: "Existing execution routes remain valid.",
    acceptanceCriteria: ["Result returns to the same session"],
    testStrategy: ["End-to-end route integration"],
  }],
  recommendedOptionIndex: 0,
};

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9router-session-execution-workspace-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/example.js"), "export const example = true;\n");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Execution Test"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
  return root;
}

function git(args, { raw = false } = {}) {
  const value = execFileSync("git", ["-C", workspaceRoot, ...args], { encoding: "utf8" });
  return raw ? value : value.trim();
}

function descriptor() {
  const file = fs.readFileSync(path.join(workspaceRoot, "src/example.js"));
  return {
    root: workspaceRoot,
    branch: git(["symbolic-ref", "--short", "HEAD"]),
    commitSha: git(["rev-parse", "HEAD"]),
    fileHashes: { "src/example.js": createHash("sha256").update(file).digest("hex") },
  };
}

function apiRequest(key, planId, body) {
  return new Request(`https://router.example/api/v1/planning/sessions/${planId}/actions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function workerRequest(pathname, body) {
  return new Request(`https://router.example${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.EXECUTION_WORKER_SECRET}`,
      "x-execution-worker-id": "session-codex-worker",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function bootApproved() {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete global._projectMemoryWorker;
  vi.resetModules();
  const database = await import("@/lib/db/index.js");
  const projects = await import("@/lib/projectMemory/repository.js");
  const planning = await import("@/lib/planning/service.js");
  const actions = await import("@/app/api/v1/planning/sessions/[planId]/actions/route.js");
  const sessions = await import("@/app/api/v1/planning/sessions/[planId]/route.js");
  const claim = await import("@/app/api/v1/executions/claim/route.js");
  const complete = await import("@/app/api/v1/executions/complete/route.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const project = await projects.createProject({ name: "Planning execution handoff" }, owner);
  const key = await database.createApiKey("Execution session key", "execution-session-key");
  await projects.assignApiKeyToProject(key.id, project.id, owner);
  await database.updateApiKey(key.id, { planning: {
    planningEnabled: true, planningMode: "ADAPTIVE", planningProviderId: "test",
    planningModelId: "local", approvalRequired: true, contextTokenBudget: 1200,
    planExpiration: 60, failurePolicy: "FAIL_CLOSED",
  } });
  const provider = {
    validateCapabilities: vi.fn(async () => ({ structuredOutput: true })),
    generatePlan: vi.fn(async () => ({ plan: output, usage: {}, attempts: 1 })),
  };
  let plan = await planning.createPlan(project.id, {
    originalRequest: "Execute this approved plan", providerId: "test", modelId: "local",
  }, owner, { provider, apiKeyId: key.id });
  plan = await planning.selectOption(project.id, plan.id, {
    expectedVersion: plan.version, optionId: plan.options[0].id,
  }, owner);
  plan = await planning.requestApproval(project.id, plan.id, { expectedVersion: plan.version }, owner);
  plan = await planning.approvePlan(project.id, plan.id, {
    expectedVersion: plan.version, optionId: plan.selectedOptionId,
    scope: "EXECUTE_APPROVED_PLAN", idempotencyKey: "execution-handoff-approval-000001",
  }, owner);
  return { actions, adapter: await getAdapter(), claim, complete, key, plan, sessions };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-session-execution-"));
  workspaceRoot = createWorkspace();
  process.env.DATA_DIR = tempDir;
  process.env.EXECUTION_TICKET_SECRET = "session-ticket-secret-012345678901234567890";
  process.env.EXECUTION_WORKER_SECRET = "session-worker-secret-012345678901234567890";
  process.env.EXECUTION_WORKSPACE_ROOTS = workspaceRoot;
});

afterEach(() => {
  if (global._projectMemoryWorker?.timer) clearTimeout(global._projectMemoryWorker.timer);
  delete global._projectMemoryWorker;
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (workspaceRoot) fs.rmSync(workspaceRoot, { recursive: true, force: true });
  for (const [name, value] of Object.entries({
    DATA_DIR: originals.dataDir,
    EXECUTION_TICKET_SECRET: originals.ticket,
    EXECUTION_WORKER_SECRET: originals.worker,
    EXECUTION_WORKSPACE_ROOTS: originals.roots,
  })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Planning session execution handoff", () => {
  it("prepares, claims and completes an approved session without exposing the ticket on poll", async () => {
    const { actions, adapter, claim, complete, key, plan, sessions } = await bootApproved();
    const { hashWorkspaceState } = await import("@/lib/execution/workspace.js");
    const workspace = descriptor();
    workspace.workingTreeHash = await hashWorkspaceState(workspaceRoot);
    const preparedResponse = await actions.POST(apiRequest(key, plan.id, {
      action: "prepare_execution",
      expectedVersion: plan.version,
      workerId: "session-codex-worker",
      workspace,
      timeoutMs: 20000,
      expirationMinutes: 5,
    }), { params: Promise.resolve({ planId: plan.id }) });
    expect(preparedResponse.status).toBe(201);
    const prepared = await preparedResponse.json();
    expect(prepared).toMatchObject({
      status: "APPROVED",
      execution: { status: "QUEUED", workerId: "session-codex-worker" },
      executionHandoff: { workerId: "session-codex-worker" },
      availableActions: expect.arrayContaining(["cancel_execution"]),
    });
    expect(prepared.executionHandoff.ticket).toBeTruthy();
    expect(JSON.stringify(prepared.execution)).not.toContain(workspaceRoot);
    const stored = adapter.get("SELECT ticketHash, sourceRevision FROM planExecutions WHERE planId=?", [plan.id]);
    expect(stored.ticketHash).not.toBe(prepared.executionHandoff.ticket);
    expect(stored.sourceRevision).toContain("workingTreeHash");
    const duplicate = await actions.POST(apiRequest(key, plan.id, {
      action: "prepare_execution", expectedVersion: plan.version, workerId: "session-codex-worker",
      workspace, timeoutMs: 20000,
    }), { params: Promise.resolve({ planId: plan.id }) });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: "EXECUTION_DUPLICATE" } });

    const polledResponse = await sessions.GET(new Request(
      `https://router.example/api/v1/planning/sessions/${plan.id}`,
      { headers: { authorization: `Bearer ${key.key}` } },
    ), { params: Promise.resolve({ planId: plan.id }) });
    const polledText = await polledResponse.text();
    expect(polledText).not.toContain(prepared.executionHandoff.ticket);
    expect(polledText).not.toContain("ticketHash");
    expect(polledText).not.toContain("sourceRevision");

    const claimedResponse = await claim.POST(workerRequest("/api/v1/executions/claim", {
      ticket: prepared.executionHandoff.ticket,
    }));
    expect(claimedResponse.status).toBe(200);
    expect(await claimedResponse.json()).toMatchObject({ execution: { status: "EXECUTING" } });

    fs.writeFileSync(path.join(workspaceRoot, "src/example.js"), "export const example = false;\n");
    const completedResponse = await complete.POST(workerRequest("/api/v1/executions/complete", {
      ticket: prepared.executionHandoff.ticket,
      result: {
        exitStatus: 0,
        modifiedFiles: ["src/example.js"],
        diffSummary: "1 file changed",
        testResults: { passed: 1 },
        filteredLogs: "completed safely",
        tokenUsage: { totalTokens: 10 },
        durationMs: 50,
      },
    }));
    expect(completedResponse.status).toBe(200);
    const finalResponse = await sessions.GET(new Request(
      `https://router.example/api/v1/planning/sessions/${plan.id}`,
      { headers: { authorization: `Bearer ${key.key}` } },
    ), { params: Promise.resolve({ planId: plan.id }) });
    expect(await finalResponse.json()).toMatchObject({
      status: "COMPLETED",
      execution: { status: "COMPLETED", exitStatus: 0, modifiedFiles: ["src/example.js"] },
    });
    expect(adapter.get("SELECT COUNT(*) AS count FROM memoryItems WHERE sourceType='tool-verified'").count).toBe(1);
  });

  it("marks the handoff stale when the working tree changes before claim", async () => {
    const { actions, adapter, claim, key, plan } = await bootApproved();
    const { hashWorkspaceState } = await import("@/lib/execution/workspace.js");
    const workspace = descriptor();
    workspace.workingTreeHash = await hashWorkspaceState(workspaceRoot);
    const prepared = await (await actions.POST(apiRequest(key, plan.id, {
      action: "prepare_execution", expectedVersion: plan.version, workerId: "session-codex-worker",
      workspace, timeoutMs: 20000,
    }), { params: Promise.resolve({ planId: plan.id }) })).json();
    fs.writeFileSync(path.join(workspaceRoot, "unapproved.txt"), "changed after approval\n");
    const claimResponse = await claim.POST(workerRequest("/api/v1/executions/claim", {
      ticket: prepared.executionHandoff.ticket,
    }));
    expect(claimResponse.status).toBe(409);
    expect(await claimResponse.json()).toMatchObject({ code: "EXECUTION_STALE" });
    expect(adapter.get("SELECT status, errorCode FROM planExecutions WHERE planId=?", [plan.id])).toMatchObject({
      status: "STALE", errorCode: "STALE_WORKSPACE",
    });
  });

  it("detects content drift even when Git status remains the same", async () => {
    const { actions, adapter, claim, key, plan } = await bootApproved();
    const { hashWorkspaceState } = await import("@/lib/execution/workspace.js");
    fs.writeFileSync(path.join(workspaceRoot, "src/example.js"), "export const example = 'first dirty value';\n");
    const workspace = descriptor();
    workspace.fileHashes = {};
    workspace.workingTreeHash = await hashWorkspaceState(workspaceRoot);
    const prepared = await (await actions.POST(apiRequest(key, plan.id, {
      action: "prepare_execution", expectedVersion: plan.version, workerId: "session-codex-worker",
      workspace, timeoutMs: 20000,
    }), { params: Promise.resolve({ planId: plan.id }) })).json();

    fs.writeFileSync(path.join(workspaceRoot, "src/example.js"), "export const example = 'second dirty value';\n");
    expect(git(["status", "--porcelain"])).toBe("M src/example.js");
    const claimResponse = await claim.POST(workerRequest("/api/v1/executions/claim", {
      ticket: prepared.executionHandoff.ticket,
    }));
    expect(claimResponse.status).toBe(409);
    expect(await claimResponse.json()).toMatchObject({ code: "EXECUTION_STALE" });
    expect(adapter.get("SELECT status, errorCode FROM planExecutions WHERE planId=?", [plan.id])).toMatchObject({
      status: "STALE", errorCode: "STALE_WORKSPACE",
    });
  });

  it("lets the owning API key cancel a queued execution through the session protocol", async () => {
    const { actions, adapter, key, plan } = await bootApproved();
    const { hashWorkspaceState } = await import("@/lib/execution/workspace.js");
    const workspace = descriptor();
    workspace.workingTreeHash = await hashWorkspaceState(workspaceRoot);
    const prepared = await (await actions.POST(apiRequest(key, plan.id, {
      action: "prepare_execution", expectedVersion: plan.version, workerId: "session-codex-worker",
      workspace, timeoutMs: 20000,
    }), { params: Promise.resolve({ planId: plan.id }) })).json();

    const cancelledResponse = await actions.POST(apiRequest(key, plan.id, {
      action: "cancel_execution", expectedVersion: prepared.version, reason: "User cancelled before claim",
    }), { params: Promise.resolve({ planId: plan.id }) });
    expect(cancelledResponse.status).toBe(200);
    expect(await cancelledResponse.json()).toMatchObject({
      status: "CANCELLED",
      execution: { status: "CANCELLED", errorCode: "EXECUTION_CANCELLED" },
      availableActions: [],
    });
    expect(adapter.get("SELECT status FROM planExecutions WHERE planId=?", [plan.id]).status).toBe("CANCELLED");
  });
});
