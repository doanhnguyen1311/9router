import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const owner = { principalId: "local-admin", displayName: "Local Admin", admin: true };
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let database;
let projects;
let planning;
let adapter;

const output = {
  interpretedObjective: "Benchmark planning persistence",
  assumptions: [],
  missingInformation: [],
  constraints: [],
  affectedModules: ["src/lib/planning"],
  risks: [],
  options: [{
    name: "Benchmark option",
    summary: "Measure bounded local operations.",
    architecture: "SQLite-backed planning.",
    implementationSteps: ["Persist"],
    filesAffected: [],
    pros: ["Measured"],
    cons: [],
    risks: [],
    complexity: "low",
    compatibility: "Local benchmark only.",
    acceptanceCriteria: ["Latency remains bounded"],
    testStrategy: ["Measure p95"],
  }],
  recommendedOptionIndex: 0,
};

const provider = {
  validateCapabilities: async () => ({ structuredOutput: true }),
  generatePlan: async () => ({ plan: output, usage: { totalTokens: 0 }, attempts: 1 }),
};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-planning-benchmark-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  database = await import("@/lib/db/index.js");
  projects = await import("@/lib/projectMemory/repository.js");
  planning = await import("@/lib/planning/service.js");
  const driver = await import("@/lib/db/driver.js");
  adapter = await driver.getAdapter();
});

afterAll(() => {
  try { adapter?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Planning foundation performance", () => {
  it("keeps local create/list/read persistence latency bounded", async () => {
    const project = await projects.createProject({ name: "Planning benchmark" }, owner);
    const createDurations = [];
    const planIds = [];
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now();
      const plan = await planning.createPlan(project.id, {
        originalRequest: `Benchmark request ${index}`,
        providerId: "benchmark",
        modelId: "local",
        contextTokenBudget: 256,
      }, owner, { provider });
      createDurations.push(performance.now() - started);
      planIds.push(plan.id);
    }
    const sorted = [...createDurations].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    const listStarted = performance.now();
    const plans = await planning.listPlans(project.id, owner, { limit: 100 });
    const listMs = performance.now() - listStarted;
    const readsStarted = performance.now();
    await Promise.all(planIds.map((id) => planning.getPlan(project.id, id, owner)));
    const concurrentReadsMs = performance.now() - readsStarted;
    const metrics = {
      plans: plans.length,
      createAverageMs: Number((createDurations.reduce((sum, value) => sum + value, 0) / createDurations.length).toFixed(2)),
      createP95Ms: Number(p95.toFixed(2)),
      list30Ms: Number(listMs.toFixed(2)),
      concurrentRead30Ms: Number(concurrentReadsMs.toFixed(2)),
      foreignKeyViolations: adapter.all("PRAGMA foreign_key_check").length,
    };
    console.log("PLANNING_BENCHMARK", JSON.stringify(metrics));
    expect(metrics.plans).toBe(30);
    expect(metrics.createP95Ms).toBeLessThan(500);
    expect(metrics.list30Ms).toBeLessThan(500);
    expect(metrics.concurrentRead30Ms).toBeLessThan(1000);
    expect(metrics.foreignKeyViolations).toBe(0);
    expect(await database.exportDb()).toHaveProperty("projectMemory.executionPlans");
  });
});
