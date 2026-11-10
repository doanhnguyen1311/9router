import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

let tempDir;
let modules;
const owner = { principalId: "local-admin", displayName: "Benchmark" };

function elapsed(start) {
  return Number((performance.now() - start).toFixed(2));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  if (!Array.isArray(entries) || entries.length > 0xffff) throw new Error("Invalid ZIP entry count");
  const seen = new Set();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  let centralSize = 0;
  for (const entry of entries) {
    const name = String(entry.name || "");
    const parts = name.split("/");
    if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || parts.some((part) => !part || part === "." || part === "..") || seen.has(name)) {
      throw new Error(`Unsafe or duplicate ZIP entry: ${name}`);
    }
    seen.add(name);
    const fileName = Buffer.from(name);
    const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    if (fileName.length > 0xffff || data.length > 0xffffffff || localOffset > 0xffffffff) throw new Error("ZIP32 limit exceeded");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(localOffset, 42);
    localParts.push(local, fileName, data);
    centralParts.push(central, fileName);
    localOffset += local.length + fileName.length + data.length;
    centralSize += central.length + fileName.length;
  }
  if (localOffset + centralSize > 0xffffffff) throw new Error("ZIP32 limit exceeded");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
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

it("benchmarks bulk ZIP file indexing", { timeout: 600_000 }, async () => {
  const { repository, files, adapter } = modules;
  const requestedCount = Number.parseInt(process.env.PROJECT_FILE_BENCHMARK_COUNT ?? "50", 10);
  const fileCount = Math.min(3000, Math.max(1, Number.isFinite(requestedCount) ? requestedCount : 50));
  const project = await repository.createProject({ name: `Bulk ZIP ${fileCount} ${Date.now()}` }, owner);
  const entries = Array.from({ length: fileCount }, (_, index) => ({
    name: `src/module-${index}.ts`,
    content: `${index > 0 ? `import { module${index - 1} } from "./module-${index - 1}";\n` : ""}export function module${index}() { return ${index > 0 ? `module${index - 1}() + 1` : "0"}; }\nexport class Module${index} { value = module${index}(); }\nexport const moduleValue${index} = ${index};\n`,
  }));
  const archive = storedZip(entries);
  const lag = monitorEventLoopDelay({ resolution: 20 });
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  let firstImport;
  lag.enable();
  try {
    firstImport = await files.importProjectZip({ projectId: project.id, buffer: archive, sourceName: "bulk-benchmark.zip" }, owner);
  } finally {
    lag.disable();
  }
  const durationMs = performance.now() - started;
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
  const counts = adapter.get(
    `SELECT
      (SELECT COUNT(*) FROM projectFiles WHERE projectId=?) AS files,
      (SELECT COUNT(*) FROM projectSymbols WHERE projectId=?) AS symbols,
      (SELECT COUNT(*) FROM projectFileDependencies WHERE projectId=?) AS dependencies,
      (SELECT COUNT(*) FROM projectFileDependencies WHERE projectId=? AND targetFileId IS NOT NULL) AS resolvedDependencies`,
    [project.id, project.id, project.id, project.id],
  );
  adapter.checkpoint?.();
  const databaseBytes = fs.statSync(path.join(tempDir, "db", "data.sqlite")).size;

  const secondStarted = performance.now();
  const secondImport = await files.importProjectZip({ projectId: project.id, buffer: archive, sourceName: "bulk-benchmark.zip" }, owner);
  const secondImportDurationMs = performance.now() - secondStarted;
  const unchangedCount = secondImport.results.filter((item) => item?.unchanged).length;
  const secondCounts = adapter.get(
    `SELECT
      (SELECT COUNT(*) FROM projectFiles WHERE projectId=?) AS files,
      (SELECT COUNT(*) FROM projectSymbols WHERE projectId=?) AS symbols,
      (SELECT COUNT(*) FROM projectFileDependencies WHERE projectId=?) AS dependencies,
      (SELECT COUNT(*) FROM projectFileDependencies WHERE projectId=? AND targetFileId IS NOT NULL) AS resolvedDependencies`,
    [project.id, project.id, project.id, project.id],
  );
  const duplicateSymbols = adapter.get(
    `SELECT COUNT(*) AS count FROM (
      SELECT fileId, symbolType, name FROM projectSymbols WHERE projectId=?
      GROUP BY fileId, symbolType, name HAVING COUNT(*) > 1
    )`,
    [project.id],
  ).count;
  const duplicateDependencies = adapter.get(
    `SELECT COUNT(*) AS count FROM (
      SELECT sourceFileId, targetReference, relationType FROM projectFileDependencies WHERE projectId=?
      GROUP BY sourceFileId, targetReference, relationType HAVING COUNT(*) > 1
    )`,
    [project.id],
  ).count;
  const lagMeanMs = Number(lag.mean / 1e6);
  const results = {
    fileCount,
    archiveBytes: archive.length,
    durationMs: Number(durationMs.toFixed(2)),
    filesPerSecond: Number((fileCount / (durationMs / 1000)).toFixed(2)),
    heapDeltaBytes,
    eventLoopDelay: {
      meanMs: Number.isFinite(lagMeanMs) ? Number(lagMeanMs.toFixed(2)) : null,
      maxMs: Number((lag.max / 1e6).toFixed(2)),
    },
    database: { ...counts, bytes: databaseBytes },
    secondImport: { durationMs: Number(secondImportDurationMs.toFixed(2)), unchangedCount, database: secondCounts },
  };
  console.log(`[Project file indexing benchmark] ${JSON.stringify(results)}`);

  expect(firstImport).toMatchObject({ total: fileCount, indexed: fileCount, ignored: 0, failed: 0 });
  expect(counts).toEqual({ files: fileCount, symbols: fileCount * 3, dependencies: fileCount - 1, resolvedDependencies: fileCount - 1 });
  expect(duplicateSymbols).toBe(0);
  expect(duplicateDependencies).toBe(0);
  expect(secondImport).toMatchObject({ total: fileCount, ignored: 0, failed: 0 });
  expect(secondCounts).toEqual(counts);
  expect(unchangedCount).toBe(fileCount);
  expect(secondImport.results.every((item) => item?.unchanged)).toBe(true);
});
