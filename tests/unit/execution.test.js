import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalTicketSecret = process.env.EXECUTION_TICKET_SECRET;
const originalWorkerSecret = process.env.EXECUTION_WORKER_SECRET;
const owner = { principalId: "local-admin", displayName: "Local Admin", admin: true };

const output = {
  interpretedObjective: "Implement and verify an approved execution",
  assumptions: [],
  missingInformation: [],
  constraints: ["Stay inside the workspace"],
  affectedModules: ["src/example.js"],
  risks: [],
  options: [{
    name: "Safe local execution",
    summary: "Run Codex with workspace-write sandbox",
    architecture: "Local worker validates the repository before invoking Codex CLI.",
    implementationSteps: ["Validate workspace", "Run Codex", "Collect diff"],
    filesAffected: ["src/example.js"],
    pros: ["Scoped"],
    cons: [],
    risks: [],
    complexity: "medium",
    compatibility: "Existing API requests remain unchanged.",
    acceptanceCriteria: ["Exit status is recorded"],
    testStrategy: ["Worker integration"],
  }],
  recommendedOptionIndex: 0,
};

async function boot() {
  delete global._dbAdapter;
  delete global._projectMemoryWorker;
  vi.resetModules();
  const projects = await import("@/lib/projectMemory/repository.js");
  const planning = await import("@/lib/planning/service.js");
  const execution = await import("@/lib/execution/service.js");
  const workspace = await import("@/lib/execution/workspace.js");
  const codexCli = await import("@/lib/execution/codexCli.js");
  const auth = await import("@/lib/execution/auth.js");
  const database = await import("@/lib/db/index.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  return { projects, planning, execution, workspace, codexCli, auth, database, adapter: await getAdapter() };
}

function createGitWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9router-workspace-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/example.js"), "export const example = true;\n");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Execution Test"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
  return root;
}

async function approvedPlan(planning, projects, projectName) {
  const project = await projects.createProject({ name: projectName }, owner);
  const provider = {
    validateCapabilities: vi.fn(async () => ({ structuredOutput: true })),
    generatePlan: vi.fn(async () => ({ plan: output, usage: {}, attempts: 1 })),
  };
  let plan = await planning.createPlan(project.id, { originalRequest: "Implement example", providerId: "test", modelId: "local" }, owner, { provider });
  plan = await planning.selectOption(project.id, plan.id, { expectedVersion: plan.version, optionId: plan.options[0].id }, owner);
  plan = await planning.requestApproval(project.id, plan.id, { expectedVersion: plan.version }, owner);
  plan = await planning.approvePlan(project.id, plan.id, {
    expectedVersion: plan.version,
    optionId: plan.selectedOptionId,
    scope: "EXECUTE_APPROVED_PLAN",
    idempotencyKey: `${project.id}-approval-nonce-000001`,
  }, owner);
  return { project, plan };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-execution-"));
  process.env.DATA_DIR = tempDir;
  process.env.EXECUTION_TICKET_SECRET = "phase-three-ticket-secret-012345678901234567890";
  process.env.EXECUTION_WORKER_SECRET = "phase-three-worker-secret-012345678901234567890";
});

afterEach(() => {
  if (global._projectMemoryWorker?.timer) clearTimeout(global._projectMemoryWorker.timer);
  delete global._projectMemoryWorker;
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
  if (originalTicketSecret === undefined) delete process.env.EXECUTION_TICKET_SECRET; else process.env.EXECUTION_TICKET_SECRET = originalTicketSecret;
  if (originalWorkerSecret === undefined) delete process.env.EXECUTION_WORKER_SECRET; else process.env.EXECUTION_WORKER_SECRET = originalWorkerSecret;
});

describe("Codex CLI contract", () => {
  it("uses verified non-interactive flags and never requests dangerous bypass", async () => {
    const { codexCli } = await boot();
    const root = createGitWorkspace();
    const calls = [];
    const fakeExecFile = vi.fn(async (_command, args) => {
      calls.push(args);
      return { stdout: args[0] === "--version" ? "codex-cli 0.165.0" : "--sandbox\n--output-last-message\n--json\n-C, --cd" };
    });
    const spawnCalls = [];
    const fakeSpawn = vi.fn((_command, args) => {
      spawnCalls.push(args);
      const child = new EventEmitter();
      child.stdin = { end: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });
    const executor = new codexCli.CodexCliExecutor({ execFile: fakeExecFile, spawn: fakeSpawn, fsImpl: fsPromises });
    const result = await executor.run({ plan: { ...output, options: [{ ...output.options[0], id: "option-1" }], selectedOptionId: "option-1" }, workspaceRoot: root, timeoutMs: 10_000 });
    expect(result.exitStatus).toBe(0);
    expect(spawnCalls[0]).toEqual(expect.arrayContaining(["exec", "--sandbox", "workspace-write", "--json", "--output-last-message", "-"]));
    expect(spawnCalls[0]).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(spawnCalls[0]).not.toContain("--dangerously-bypass-hook-trust");
    expect(calls[0]).toEqual(["--version"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("verifies the installed Codex CLI contract before execution", async () => {
    const { codexCli } = await boot();
    const contract = await codexCli.inspectCodexCli({ command: process.env.CODEX_BIN || "codex" });
    expect(contract.version).toMatch(/codex/i);
    expect(contract.requiredFlags).toEqual(expect.arrayContaining(["--sandbox", "--output-last-message", "--json", "-C, --cd"]));
  });
});

describe("Execution worker authentication", () => {
  it("requires the configured bearer secret and a scoped worker id", async () => {
    const { auth } = await boot();
    const valid = new Request("http://localhost/api/v1/executions/claim", {
      headers: {
        authorization: `Bearer ${process.env.EXECUTION_WORKER_SECRET}`,
        "x-execution-worker-id": "worker-auth-test",
      },
    });
    expect(auth.verifyWorkerRequest(valid)).toEqual({ workerId: "worker-auth-test" });
    const invalid = new Request("http://localhost/api/v1/executions/claim", {
      headers: { authorization: "Bearer wrong-secret", "x-execution-worker-id": "worker-auth-test" },
    });
    expect(() => auth.verifyWorkerRequest(invalid)).toThrowError(/authentication failed/i);
  });
});

describe("Execution ticket and worker state machine", () => {
  it("issues a scoped ticket, validates workspace, prevents duplicates, completes and records verified memory", async () => {
    const { projects, planning, execution, workspace, database, adapter } = await boot();
    const { project, plan } = await approvedPlan(planning, projects, "Execution success");
    const root = createGitWorkspace();
    const hashes = await workspace.hashWorkspaceFiles(root, ["src/example.js"]);
    const branch = execFileSync("git", ["-C", root, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const commitSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const ticket = await execution.issueExecutionTicket(project.id, plan.id, {
      expectedVersion: plan.version,
      workerId: "worker-local-1",
      timeoutMs: 20_000,
      workspace: { root, branch, commitSha, fileHashes: hashes },
    }, owner);
    expect(ticket.ticket).not.toContain("worker-local-1");
    expect(ticket.execution).toMatchObject({ status: "QUEUED", workerId: "worker-local-1", approvedPlanVersion: plan.version });
    await expect(execution.issueExecutionTicket(project.id, plan.id, {
      expectedVersion: plan.version, workerId: "worker-local-1", workspace: { root, branch, commitSha, fileHashes: hashes },
    }, owner)).rejects.toMatchObject({ code: "EXECUTION_DUPLICATE", status: 409 });

    const claimed = await execution.claimExecutionTicket(ticket.ticket, "worker-local-1", { validateWorkspace: (descriptor) => workspace.validateWorkspace(descriptor, { allowedRoots: [root] }) });
    expect(claimed.execution.status).toBe("EXECUTING");
    expect(claimed.plan.id).toBe(plan.id);
    const completed = await execution.completeExecutionTicket(ticket.ticket, "worker-local-1", {
      exitStatus: 0,
      modifiedFiles: ["src/example.js", "../outside.js"],
      diffSummary: "1 file changed",
      filteredLogs: "safe sk-abcdefghijklmnopqrst",
      tokenUsage: { total: 12 },
      durationMs: 50,
    });
    expect(completed).toMatchObject({ status: "COMPLETED", modifiedFiles: ["src/example.js"] });
    expect(completed.filteredLogs).toContain("[REDACTED:api-token]");
    expect(completed.filteredLogs).not.toContain("sk-abcdefghijklmnopqrst");
    expect(adapter.get("SELECT status FROM executionPlans WHERE id=?", [plan.id]).status).toBe("COMPLETED");
    expect(adapter.get("SELECT COUNT(*) AS count FROM memoryItems WHERE projectId=? AND sourceType='tool-verified'", [project.id]).count).toBe(1);
    const backup = await database.exportDb();
    expect(backup.projectMemory.planExecutions).toHaveLength(1);
    await database.importDb(backup);
    expect(adapter.get("SELECT status FROM planExecutions WHERE id=?", [ticket.execution.id]).status).toBe("COMPLETED");
    expect(adapter.all("PRAGMA foreign_key_check")).toEqual([]);
    await expect(execution.claimExecutionTicket(ticket.ticket, "worker-local-1", { validateWorkspace: (descriptor) => workspace.validateWorkspace(descriptor, { allowedRoots: [root] }) })).rejects.toMatchObject({ code: "EXECUTION_STATE_CONFLICT", status: 409 });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("marks a ticket stale when a relevant file changes and never runs Codex", async () => {
    const { projects, planning, execution, workspace, adapter } = await boot();
    const { project, plan } = await approvedPlan(planning, projects, "Execution stale");
    const root = createGitWorkspace();
    const hashes = await workspace.hashWorkspaceFiles(root, ["src/example.js"]);
    const branch = execFileSync("git", ["-C", root, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const commitSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const ticket = await execution.issueExecutionTicket(project.id, plan.id, { expectedVersion: plan.version, workerId: "worker-local-2", workspace: { root, branch, commitSha, fileHashes: hashes } }, owner);
    fs.writeFileSync(path.join(root, "src/example.js"), "export const example = false;\n");
    await expect(execution.claimExecutionTicket(ticket.ticket, "worker-local-2", { validateWorkspace: (descriptor) => workspace.validateWorkspace(descriptor, { allowedRoots: [root] }) })).rejects.toMatchObject({ code: "EXECUTION_STALE", status: 409 });
    expect(adapter.get("SELECT status FROM planExecutions WHERE id=?", [ticket.execution.id]).status).toBe("STALE");
    expect(adapter.get("SELECT status FROM executionPlans WHERE id=?", [plan.id]).status).toBe("STALE");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("marks an execution stale when the approved plan version changes before claim", async () => {
    const { projects, planning, execution, workspace, adapter } = await boot();
    const { project, plan } = await approvedPlan(planning, projects, "Execution approval drift");
    const root = createGitWorkspace();
    const hashes = await workspace.hashWorkspaceFiles(root, ["src/example.js"]);
    const branch = execFileSync("git", ["-C", root, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const commitSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const ticket = await execution.issueExecutionTicket(project.id, plan.id, { expectedVersion: plan.version, workerId: "worker-local-approval-drift", workspace: { root, branch, commitSha, fileHashes: hashes } }, owner);
    adapter.run("UPDATE executionPlans SET version=version+1 WHERE id=?", [plan.id]);
    await expect(execution.claimExecutionTicket(ticket.ticket, "worker-local-approval-drift", { validateWorkspace: (descriptor) => workspace.validateWorkspace(descriptor, { allowedRoots: [root] }) })).rejects.toMatchObject({ code: "EXECUTION_STALE", status: 409 });
    expect(adapter.get("SELECT status FROM planExecutions WHERE id=?", [ticket.execution.id]).status).toBe("STALE");
    expect(adapter.get("SELECT status FROM executionPlans WHERE id=?", [plan.id]).status).toBe("STALE");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("recovers expired leases and rejects unsafe paths", async () => {
    const { projects, planning, execution, workspace, adapter } = await boot();
    const { project, plan } = await approvedPlan(planning, projects, "Execution recovery");
    const root = createGitWorkspace();
    const hashes = await workspace.hashWorkspaceFiles(root, ["src/example.js"]);
    const branch = execFileSync("git", ["-C", root, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const commitSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const ticket = await execution.issueExecutionTicket(project.id, plan.id, { expectedVersion: plan.version, workerId: "worker-local-3", workspace: { root, branch, commitSha, fileHashes: hashes } }, owner);
    await execution.claimExecutionTicket(ticket.ticket, "worker-local-3", { validateWorkspace: (descriptor) => workspace.validateWorkspace(descriptor, { allowedRoots: [root] }) });
    adapter.run("UPDATE planExecutions SET leaseUntil=? WHERE id=?", ["2000-01-01T00:00:00.000Z", ticket.execution.id]);
    expect(await execution.recoverExecutionLeases()).toBe(1);
    expect(adapter.get("SELECT status, errorCode FROM planExecutions WHERE id=?", [ticket.execution.id])).toMatchObject({ status: "FAILED", errorCode: "WORKER_LEASE_EXPIRED" });
    expect(() => workspace.normalizeWorkspaceDescriptor({ root, fileHashes: { "../outside": "a".repeat(64) } })).toThrowError(/traversal/i);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("supports authorized cancellation before and during execution", async () => {
    const { projects, planning, execution, workspace, adapter } = await boot();
    const queued = await approvedPlan(planning, projects, "Execution queued cancellation");
    const root = createGitWorkspace();
    const descriptor = { root };
    const queuedTicket = await execution.issueExecutionTicket(queued.project.id, queued.plan.id, {
      expectedVersion: queued.plan.version, workerId: "worker-cancel-queued", workspace: descriptor,
    }, owner);
    const queuedCancelled = await execution.requestCancellation(queued.project.id, queuedTicket.execution.id, { reason: "User changed scope" }, owner);
    expect(queuedCancelled).toMatchObject({ status: "CANCELLED", errorCode: "EXECUTION_CANCELLED" });
    expect(adapter.get("SELECT status FROM executionPlans WHERE id=?", [queued.plan.id]).status).toBe("CANCELLED");

    const running = await approvedPlan(planning, projects, "Execution running cancellation");
    const runningTicket = await execution.issueExecutionTicket(running.project.id, running.plan.id, {
      expectedVersion: running.plan.version, workerId: "worker-cancel-running", workspace: descriptor,
    }, owner);
    await execution.claimExecutionTicket(runningTicket.ticket, "worker-cancel-running", { validateWorkspace: (value) => workspace.validateWorkspace(value, { allowedRoots: [root] }) });
    const cancellationRequested = await execution.requestCancellation(running.project.id, runningTicket.execution.id, { reason: "Stop running task" }, owner);
    expect(cancellationRequested.status).toBe("EXECUTING");
    expect(cancellationRequested.cancelRequestedAt).toBeTruthy();
    const heartbeat = await execution.heartbeatExecutionTicket(runningTicket.ticket, "worker-cancel-running");
    expect(heartbeat.cancelRequestedAt).toBeTruthy();
    const completed = await execution.completeExecutionTicket(runningTicket.ticket, "worker-cancel-running", { cancelled: true, errorMessage: "Stop running task" });
    expect(completed.status).toBe("CANCELLED");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("collects tracked and untracked changes without reading outside the workspace", async () => {
    const { workspace } = await boot();
    const root = createGitWorkspace();
    fs.writeFileSync(path.join(root, "src/example.js"), "export const example = false;\n");
    fs.writeFileSync(path.join(root, "src/new.js"), "export const added = true;\n");
    const result = await workspace.collectWorkspaceResult(root);
    expect(result.modifiedFiles).toEqual(expect.arrayContaining(["src/example.js", "src/new.js"]));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when the workspace is outside the worker allowlist", async () => {
    const { workspace } = await boot();
    const root = createGitWorkspace();
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "9router-allowed-root-"));
    await expect(workspace.validateWorkspace({ root }, { allowedRoots: [otherRoot] })).rejects.toMatchObject({ code: "WORKSPACE_NOT_ALLOWED", status: 403 });
    await expect(workspace.validateWorkspace({ root }, { allowedRoots: [] })).rejects.toMatchObject({ code: "WORKSPACE_POLICY_UNAVAILABLE", status: 503 });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(otherRoot, { recursive: true, force: true });
  });
});
