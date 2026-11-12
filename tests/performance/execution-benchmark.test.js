import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const owner = { principalId: "local-admin", displayName: "Execution benchmark", admin: true };
const output = {
  interpretedObjective: "Benchmark approved execution overhead",
  assumptions: [], missingInformation: [], constraints: [], affectedModules: ["src/example.js"], risks: [],
  options: [{
    name: "Scoped worker execution", summary: "Validate then execute locally", architecture: "Ticketed worker",
    implementationSteps: ["Issue ticket", "Claim", "Report"], filesAffected: [], pros: ["Bounded"], cons: [], risks: [],
    complexity: "low", compatibility: "Legacy requests unchanged", acceptanceCriteria: ["Terminal state is recorded"], testStrategy: ["Worker test"],
  }],
  recommendedOptionIndex: 0,
};

let tempDir;
let modules;
const originalDataDir = process.env.DATA_DIR;
const originalTicketSecret = process.env.EXECUTION_TICKET_SECRET;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-execution-benchmark-"));
  process.env.DATA_DIR = tempDir;
  process.env.EXECUTION_TICKET_SECRET = "phase-three-benchmark-ticket-secret-012345678901234567890";
  delete global._dbAdapter;
  delete global._projectMemoryWorker;
  vi.resetModules();
  const projects = await import("@/lib/projectMemory/repository.js");
  const planning = await import("@/lib/planning/service.js");
  const execution = await import("@/lib/execution/service.js");
  modules = { projects, planning, execution };
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
  if (originalTicketSecret === undefined) delete process.env.EXECUTION_TICKET_SECRET; else process.env.EXECUTION_TICKET_SECRET = originalTicketSecret;
});

describe("Codex execution performance", () => {
  it("measures ticket-to-terminal local overhead and records token benchmark limits", async () => {
    const { projects, planning, execution } = modules;
    const project = await projects.createProject({ name: "Execution benchmark" }, owner);
    const provider = {
      validateCapabilities: async () => ({ structuredOutput: true }),
      generatePlan: async () => ({ plan: output, usage: { totalTokens: 0 }, attempts: 1 }),
    };
    const durations = [];
    const workspaceRoot = path.join(tempDir, "workspace");
    fs.mkdirSync(workspaceRoot);
    for (let index = 0; index < 20; index += 1) {
      const plan = await planning.createPlan(project.id, { originalRequest: `Benchmark execution ${index}`, providerId: "benchmark", modelId: "local" }, owner, { provider });
      const selected = await planning.selectOption(project.id, plan.id, { expectedVersion: plan.version, optionId: plan.options[0].id }, owner);
      const pending = await planning.requestApproval(project.id, plan.id, { expectedVersion: selected.version }, owner);
      const approved = await planning.approvePlan(project.id, plan.id, {
        expectedVersion: pending.version, optionId: pending.selectedOptionId, scope: "EXECUTE_APPROVED_PLAN", idempotencyKey: `benchmark-key-${randomUUID()}`,
      }, owner);
      const started = performance.now();
      const ticket = await execution.issueExecutionTicket(project.id, plan.id, {
        expectedVersion: approved.version, workerId: `benchmark-worker-${index}`, workspace: { root: workspaceRoot },
      }, owner);
      await execution.claimExecutionTicket(ticket.ticket, `benchmark-worker-${index}`, { validateWorkspace: async (descriptor) => ({ root: descriptor.root, stale: false, staleReasons: [] }) });
      await execution.cancelExecutionTicket(ticket.ticket, `benchmark-worker-${index}`, "benchmark cleanup");
      durations.push(performance.now() - started);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const metrics = {
      iterations: durations.length,
      ticketClaimCancelAverageMs: Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(2)),
      ticketClaimCancelP95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2)),
      tokenBenchmark: {
        baselineDirectCodex: { status: "NOT_TESTED", reason: "No external Codex/LLM billing credentials were used in this local benchmark" },
        planningApprovalCodex: { status: "NOT_TESTED", reason: "Requires a real planner and Codex task corpus; local provider emitted zero synthetic tokens" },
        planningCachedContextCodex: { status: "NOT_TESTED", reason: "Requires a real planner and Codex task corpus; local provider emitted zero synthetic tokens" },
      },
    };
    console.log("CODEX_EXECUTION_BENCHMARK", JSON.stringify(metrics));
    expect(metrics.iterations).toBe(20);
    expect(metrics.ticketClaimCancelP95Ms).toBeLessThan(500);
  });
});
