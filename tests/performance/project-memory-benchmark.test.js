import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

let tempDir;
let modules;
const owner = { principalId: "local-admin", displayName: "Benchmark" };

function elapsed(start) {
  return Number((performance.now() - start).toFixed(2));
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-memory-benchmark-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._projectMemoryWorker;
  vi.resetModules();
  const repository = await import("@/lib/projectMemory/repository.js");
  const memory = await import("@/lib/projectMemory/memoryRepository.js");
  const retrieval = await import("@/lib/projectMemory/retrieval.js");
  const graph = await import("@/lib/projectMemory/graphRepository.js");
  const files = await import("@/lib/projectMemory/fileIntelligence.js");
  const queue = await import("@/lib/projectMemory/queue.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  modules = { repository, memory, retrieval, graph, files, queue, adapter: await getAdapter() };
});

afterAll(() => {
  if (global._projectMemoryWorker?.timer) clearTimeout(global._projectMemoryWorker.timer);
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete global._projectMemoryWorker;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

it("measures representative local Project Memory workloads", { timeout: 60_000 }, async () => {
  const { repository, memory, retrieval, graph, files, queue, adapter } = modules;
  const project = await repository.createProject({ name: "Benchmark" }, owner);
  const results = {
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      sqliteDriver: adapter.driver,
      dataset: { memories: 2000, graphEntities: 300, files: 50, queueEvents: 200 },
    },
  };

  let started = performance.now();
  adapter.transaction(() => {
    for (let index = 0; index < 2000; index += 1) {
      memory.upsertMemoryInTransaction(adapter, {
        projectId: project.id,
        memoryType: index % 7 === 0 ? "constraint" : index % 5 === 0 ? "decision" : "technical_fact",
        subject: `Module ${index}`,
        value: `Router module ${index} uses SQLite gateway session dependency ${index % 50}`,
        confidence: 0.8,
        sourceType: "tool-verified",
        evidenceReference: `benchmark:${index}`,
        pinned: index % 100 === 0,
        status: index % 100 === 0 ? "pinned" : "active",
      });
    }
  });
  results.memorySeedMs = elapsed(started);

  started = performance.now();
  const entities = [];
  adapter.transaction(() => {
    for (let index = 0; index < 300; index += 1) {
      entities.push(graph.upsertEntityInTransaction(adapter, {
        projectId: project.id, entityType: "module", name: `GraphModule${index}`,
        sourceType: "tool-verified", confidence: 1,
      }));
    }
    for (let index = 1; index < entities.length; index += 1) {
      graph.upsertRelationInTransaction(adapter, {
        projectId: project.id, fromEntityId: entities[index - 1].id, toEntityId: entities[index].id,
        relationType: "DEPENDS_ON", evidenceType: "benchmark", confidence: 1,
      });
    }
  });
  results.graphSeedMs = elapsed(started);

  started = performance.now();
  for (let index = 0; index < 50; index += 1) {
    const previous = index > 0 ? `import { module${index - 1} } from "./module-${index - 1}";\n` : "";
    await files.indexProjectFile({
      projectId: project.id,
      relativePath: `src/module-${index}.ts`,
      buffer: Buffer.from(`${previous}export function module${index}() { return ${index}; }`),
    }, owner);
  }
  results.fileIndexing = {
    durationMs: elapsed(started),
    filesPerSecond: Number((50 / ((performance.now() - started) / 1000)).toFixed(2)),
  };

  const retrievalDurations = [];
  let lastContext;
  for (let index = 0; index < 100; index += 1) {
    started = performance.now();
    lastContext = await retrieval.retrieveProjectContext({
      projectId: project.id, query: `SQLite gateway module ${index % 50}`, tokenBudget: 1800, maxGraphDepth: 2,
    });
    retrievalDurations.push(performance.now() - started);
  }
  retrievalDurations.sort((a, b) => a - b);
  results.memoryRetrieval = {
    iterations: 100,
    averageMs: Number((retrievalDurations.reduce((sum, value) => sum + value, 0) / retrievalDurations.length).toFixed(2)),
    p95Ms: Number(retrievalDurations[94].toFixed(2)),
    contextTokens: lastContext.tokenEstimate,
  };

  const graphDurations = [];
  for (let index = 0; index < 100; index += 1) {
    started = performance.now();
    await graph.searchGraph(project.id, owner.principalId, { entityId: entities[index % entities.length].id, depth: 3, limit: 100 });
    graphDurations.push(performance.now() - started);
  }
  graphDurations.sort((a, b) => a - b);
  results.graphTraversal = {
    iterations: 100,
    averageMs: Number((graphDurations.reduce((sum, value) => sum + value, 0) / graphDurations.length).toFixed(2)),
    p95Ms: Number(graphDurations[94].toFixed(2)),
  };

  started = performance.now();
  for (let index = 0; index < 200; index += 1) {
    await queue.enqueueMemoryEvent({
      projectId: project.id, eventType: "tool-result", sourceType: "tool-verified",
      payload: { text: `Benchmark service ${index} uses queue dependency ${index}.` },
      evidenceReference: `benchmark-queue:${index}`,
    });
  }
  if (global._projectMemoryWorker?.timer) clearTimeout(global._projectMemoryWorker.timer);
  global._projectMemoryWorker.scheduled = false;
  let processed = 0;
  while (true) {
    const count = await queue.runMemoryWorkerOnce();
    processed += count;
    if (!count) break;
  }
  const queueDuration = performance.now() - started;
  results.queue = { durationMs: Number(queueDuration.toFixed(2)), jobs: processed, jobsPerSecond: Number((processed / (queueDuration / 1000)).toFixed(2)) };

  started = performance.now();
  await Promise.all(Array.from({ length: 50 }, (_, index) => retrieval.retrieveProjectContext({
    projectId: project.id, query: `concurrent module ${index}`, tokenBudget: 512, maxGraphDepth: 1,
  })));
  results.concurrentRetrieval50Ms = elapsed(started);

  started = performance.now();
  await Promise.all(Array.from({ length: 50 }, (_, index) => memory.createManualMemory(project.id, {
    memoryType: "technical_fact", subject: `Concurrent write ${index}`, value: `Value ${index}`,
  }, owner)));
  results.concurrentWrites50Ms = elapsed(started);

  adapter.checkpoint?.();
  const dbPath = path.join(tempDir, "db", "data.sqlite");
  results.databaseBytes = fs.statSync(dbPath).size;
  console.log(`[Project Memory benchmark] ${JSON.stringify(results)}`);

  expect(results.memoryRetrieval.averageMs).toBeGreaterThanOrEqual(0);
  expect(results.queue.jobs).toBe(200);
  expect(results.fileIndexing.filesPerSecond).toBeGreaterThan(0);
});
