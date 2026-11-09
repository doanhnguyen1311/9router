import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol.js";
import { extractMemoryCandidates } from "./extractor.js";
import { upsertMemoryInTransaction } from "./memoryRepository.js";
import { upsertEntityInTransaction, upsertRelationInTransaction } from "./graphRepository.js";
import { redactProjectText } from "./privacy.js";

const MAX_QUEUE_DEPTH = 10_000;
const LEASE_MS = 30_000;
const BATCH_SIZE = 8;
const WORKER_ID = `${process.pid}:${crypto.randomUUID()}`;

if (!global._projectMemoryWorker) {
  global._projectMemoryWorker = { running: false, scheduled: false, timer: null };
}
const workerState = global._projectMemoryWorker;

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function minimalPayload(input) {
  const redacted = redactProjectText(String(input.text || "").slice(0, 32_000));
  return {
    text: redacted.text,
    privacyRedactions: redacted.findings.slice(0, 100),
    sourceType: String(input.sourceType || "inferred").slice(0, 40),
    sourceSessionId: input.sourceSessionId || null,
    evidenceReference: String(input.evidenceReference || "").slice(0, 500) || null,
  };
}

export async function enqueueMemoryEvent({ projectId, sessionId = null, eventType, sourceType, payload, evidenceReference = null }) {
  const normalized = minimalPayload({ ...payload, sourceType, sourceSessionId: sessionId, evidenceReference });
  if (!normalized.text.trim()) return { queued: false, reason: "empty" };
  const db = await getAdapter();
  const pending = db.get("SELECT COUNT(*) AS count FROM extractionJobs WHERE state IN ('pending','processing')")?.count || 0;
  if (pending >= MAX_QUEUE_DEPTH) return { queued: false, reason: "backpressure" };
  const evidenceHash = hash(`${projectId}|${eventType}|${normalized.sourceType}|${normalized.text}`);
  const eventId = uuidv4();
  const jobId = uuidv4();
  const now = new Date().toISOString();
  let queued = false;
  db.transaction(() => {
    const existing = db.get("SELECT id FROM memoryEvents WHERE projectId=? AND evidenceHash=? AND eventType=?", [projectId, evidenceHash, eventType]);
    if (existing) return;
    db.run(
      `INSERT INTO memoryEvents(id, projectId, sessionId, eventType, sourceType, payload, evidenceHash, createdAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventId, projectId, sessionId, eventType, normalized.sourceType, stringifyJson(normalized), evidenceHash, now],
    );
    db.run(
      `INSERT INTO extractionJobs(id, projectId, eventId, jobType, state, idempotencyKey, payload,
        attempts, maxAttempts, availableAt, createdAt, updatedAt)
       VALUES(?, ?, ?, 'memory-extraction', 'pending', ?, ?, 0, 5, ?, ?, ?)`,
      [jobId, projectId, eventId, `memory:${eventId}`, stringifyJson(normalized), now, now, now],
    );
    queued = true;
  });
  if (queued) scheduleMemoryWorker();
  return { queued, eventId: queued ? eventId : null, jobId: queued ? jobId : null, reason: queued ? null : "duplicate" };
}

export async function recoverStaleJobs() {
  const db = await getAdapter();
  const now = new Date().toISOString();
  return db.run(
    `UPDATE extractionJobs SET state='pending', leaseOwner=NULL, leaseUntil=NULL, updatedAt=?
     WHERE state='processing' AND leaseUntil IS NOT NULL AND leaseUntil < ?`,
    [now, now],
  )?.changes || 0;
}

async function claimJobs(limit = BATCH_SIZE) {
  const db = await getAdapter();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
  let jobs = [];
  db.transaction(() => {
    db.run(
      `UPDATE extractionJobs SET state='pending', leaseOwner=NULL, leaseUntil=NULL, updatedAt=?
       WHERE state='processing' AND leaseUntil IS NOT NULL AND leaseUntil < ?`,
      [now.toISOString(), now.toISOString()],
    );
    const candidates = db.all(
      `SELECT id FROM extractionJobs WHERE state='pending' AND availableAt<=?
       ORDER BY createdAt ASC LIMIT ?`,
      [now.toISOString(), Math.max(1, Math.min(limit, 50))],
    );
    for (const candidate of candidates) {
      db.run(
        `UPDATE extractionJobs SET state='processing', leaseOwner=?, leaseUntil=?, attempts=attempts+1, updatedAt=?
         WHERE id=? AND state='pending'`,
        [WORKER_ID, leaseUntil, now.toISOString(), candidate.id],
      );
    }
    if (candidates.length) {
      jobs = db.all(
        `SELECT * FROM extractionJobs WHERE leaseOwner=? AND leaseUntil=? AND id IN (${candidates.map(() => "?").join(",")})`,
        [WORKER_ID, leaseUntil, ...candidates.map((item) => item.id)],
      );
    }
  });
  return jobs;
}

function relationForMemory(item) {
  const map = {
    decision: "DECIDED",
    architecture: "USES",
    dependency: "DEPENDS_ON",
    relationship: "RELATED_TO",
    constraint: "CONSTRAINED_BY",
    issue: "HAS_ISSUE",
    resolution: "RESOLVED_BY",
  };
  return map[item.memoryType] || null;
}

async function completeJob(job) {
  const db = await getAdapter();
  const payload = parseJson(job.payload, {});
  const candidates = extractMemoryCandidates(payload, {
    sourceType: payload.sourceType,
    evidenceReference: payload.evidenceReference || `event:${job.eventId}`,
  });
  const now = new Date().toISOString();
  db.transaction(() => {
    // Re-check the idempotent terminal state inside the write transaction.
    const current = db.get("SELECT state, leaseOwner FROM extractionJobs WHERE id=?", [job.id]);
    if (current?.state !== "processing" || current.leaseOwner !== WORKER_ID) return;
    for (const candidate of candidates) {
      const item = {
        ...candidate,
        projectId: job.projectId,
        sourceSessionId: payload.sourceSessionId,
        sourceEventId: job.eventId,
      };
      upsertMemoryInTransaction(db, item);
      const from = upsertEntityInTransaction(db, {
        projectId: job.projectId,
        entityType: candidate.memoryType === "file" ? "file" : "concept",
        name: candidate.subject,
        metadata: { memoryType: candidate.memoryType },
        sourceType: candidate.sourceType,
        confidence: candidate.confidence,
      });
      const relationType = relationForMemory(candidate);
      if (from && relationType && candidate.value.length <= 500) {
        const to = upsertEntityInTransaction(db, {
          projectId: job.projectId,
          entityType: candidate.memoryType === "decision" ? "decision" : "concept",
          name: candidate.value,
          metadata: { sourceEventId: job.eventId },
          sourceType: candidate.sourceType,
          confidence: candidate.confidence,
        });
        if (to) upsertRelationInTransaction(db, {
          projectId: job.projectId,
          fromEntityId: from.id,
          toEntityId: to.id,
          relationType,
          evidenceType: candidate.sourceType,
          evidenceReference: candidate.evidenceReference,
          confidence: candidate.confidence,
        });
      }
    }
    db.run("UPDATE memoryEvents SET processedAt=? WHERE id=?", [now, job.eventId]);
    db.run(
      `UPDATE extractionJobs SET state='completed', leaseOwner=NULL, leaseUntil=NULL,
       completedAt=?, updatedAt=?, lastError=NULL WHERE id=?`,
      [now, now, job.id],
    );
    db.run("UPDATE projects SET lastActivityAt=?, updatedAt=?, version=version+1 WHERE id=?", [now, now, job.projectId]);
  });
  return candidates.length;
}

async function failJob(job, error) {
  const db = await getAdapter();
  const now = new Date();
  const terminal = Number(job.attempts) >= Number(job.maxAttempts);
  const backoffMs = Math.min(60_000, 1000 * (2 ** Math.max(0, Number(job.attempts) - 1)));
  db.run(
    `UPDATE extractionJobs SET state=?, leaseOwner=NULL, leaseUntil=NULL, availableAt=?,
      lastError=?, updatedAt=? WHERE id=? AND leaseOwner=?`,
    [terminal ? "failed" : "pending", new Date(now.getTime() + backoffMs).toISOString(),
      String(error?.message || error).slice(0, 1000), now.toISOString(), job.id, WORKER_ID],
  );
}

export async function runMemoryWorkerOnce() {
  const jobs = await claimJobs();
  for (const job of jobs) {
    try { await completeJob(job); }
    catch (error) { await failJob(job, error); }
  }
  return jobs.length;
}

async function drainWorker() {
  if (workerState.running) return;
  workerState.running = true;
  workerState.scheduled = false;
  try {
    for (let batch = 0; batch < 20; batch += 1) {
      const count = await runMemoryWorkerOnce();
      if (count < BATCH_SIZE) break;
    }
    await pruneMemoryQueue();
  } catch (error) {
    console.warn("[Project Memory] extraction worker:", error.message);
  } finally {
    workerState.running = false;
  }
}

export function scheduleMemoryWorker(delayMs = 0) {
  if (workerState.running || workerState.scheduled) return;
  workerState.scheduled = true;
  workerState.timer = setTimeout(() => void drainWorker(), delayMs);
  workerState.timer?.unref?.();
}

export async function queueStats(projectId = null) {
  const db = await getAdapter();
  const where = projectId ? "WHERE projectId=?" : "";
  const params = projectId ? [projectId] : [];
  const rows = db.all(`SELECT state, COUNT(*) AS count FROM extractionJobs ${where} GROUP BY state`, params);
  return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
}

export async function pruneMemoryQueue({ completedDays = 30, failedDays = 90 } = {}) {
  const db = await getAdapter();
  const now = Date.now();
  const completedBefore = new Date(now - Math.max(1, completedDays) * 86_400_000).toISOString();
  const failedBefore = new Date(now - Math.max(1, failedDays) * 86_400_000).toISOString();
  let completed = 0;
  let failed = 0;
  db.transaction(() => {
    completed = db.run("DELETE FROM extractionJobs WHERE state='completed' AND completedAt IS NOT NULL AND completedAt<?", [completedBefore])?.changes || 0;
    failed = db.run("DELETE FROM extractionJobs WHERE state='failed' AND updatedAt<?", [failedBefore])?.changes || 0;
    db.run(
      `DELETE FROM memoryEvents WHERE id NOT IN (SELECT eventId FROM extractionJobs WHERE eventId IS NOT NULL)
       AND createdAt<?`,
      [completedBefore],
    );
  });
  return { completed, failed };
}
