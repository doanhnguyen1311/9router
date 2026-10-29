import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { DB_DIR } from '../db/paths.js';
import { historyConfig, HISTORY_LIMITS } from './config.js';
import { createCollector } from './collector.js';

export class HistoryService {
  constructor({ workerFactory, file } = {}) {
    this.config = historyConfig();
    this.file = file || path.join(DB_DIR, 'chat-history.sqlite');
    this.workerFactory = workerFactory || (() => new Worker(path.join(process.cwd(), 'src/lib/chatHistory/worker.cjs'), { workerData: { file: this.file } }));
    this.queue = []; this.bytes = 0; this.inFlight = null; this.pending = new Map();
    this.collectors = new Set(); this.active = 0; this.captureBytes = 0; this.epoch = 0; this.nextId = 0; this.retryAt = 0;
    this.stats = { dropped: 0, saved: 0, errors: 0, activeDropped: 0 };
  }
  async start() {
    // Disabled installations without existing history do not need a worker.
    if (this.config.chatHistoryEnabled) { this.ensureWorker(); return; }
    try { await access(this.file); this.ensureWorker(); } catch { /* no history to retain */ }
  }
  configure(settings) {
    const next = historyConfig(settings);
    const changed = Object.keys(next).some(key => next[key] !== this.config[key]);
    this.config = next;
    if (!changed) return;
    if (!next.chatHistoryEnabled) { this.epoch++; for (const collector of this.collectors) collector.discard(); this.stats.dropped += this.queue.length; this.queue = []; this.bytes = this.inFlight?.bytes || 0; }
    while (this.queue.length && (this.queue.length + (this.inFlight?.count || 0) > next.chatHistoryQueueCapacity || this.bytes > next.chatHistoryQueueMaxBytes)) {
      this.bytes -= this.queue.pop().bytes; this.stats.dropped++;
    }
    if (this.worker) { try { this.worker.postMessage({ type: 'config', config: next }); } catch { this.fail(this.worker); } }
    clearInterval(this.timer);
    this.timer = setInterval(() => this.flush(), next.chatHistoryFlushIntervalMs);
    this.timer.unref?.();
    // Creation never runs during request capture. Startup/settings own this work.
    if (next.chatHistoryEnabled) this.ensureWorker();
  }
  ensureWorker() {
    if (this.worker || Date.now() < this.retryAt) return;
    try {
      const worker = this.workerFactory(); this.worker = worker;
      worker.on('message', msg => {
        if (this.worker !== worker) return;
        if (msg.type === 'ready') { this.ready = true; worker.postMessage({ type: 'config', config: this.config }); }
        if (msg.type === 'batch') {
          if (this.inFlight) this.bytes -= this.inFlight.bytes;
          this.inFlight = null; clearTimeout(this.watchdog);
          this.stats.saved += msg.saved; this.stats.dropped += msg.dropped; this.stats.errors += msg.dropped;
        }
        const pending = this.pending.get(msg.id);
        if (pending) { this.pending.delete(msg.id); clearTimeout(pending.timer); msg.error ? pending.reject(new Error('History storage unavailable')) : pending.resolve(msg.result); }
      });
      worker.on('error', () => this.fail(worker));
      worker.on('exit', () => this.fail(worker));
      worker.unref();
    } catch { this.fail(this.worker); }
  }
  fail(worker) {
    if (worker && worker !== this.worker) return;
    this.worker = null; this.ready = false; this.retryAt = Date.now() + 30000;
    clearTimeout(this.watchdog);
    this.stats.errors++; this.stats.dropped += this.queue.length + (this.inFlight?.count || 0);
    this.queue = []; this.bytes = 0; this.inFlight = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('History storage unavailable')); }
    this.pending.clear();
    // No raw exception message: filesystem errors can contain sensitive paths/data.
    if (!this.lastWarning || Date.now() - this.lastWarning > 60000) { console.warn('[ChatHistory] worker unavailable; history dropped'); this.lastWarning = Date.now(); }
  }
  begin(body, endpoint, options = {}) {
    if (!this.config.chatHistoryEnabled) return null;
    // Reserve before touching content. Keep the original reservation across config changes.
    const reservation = this.config.chatHistoryMaxContentBytes * 3 + 32768;
    if (!this.ready || this.active >= HISTORY_LIMITS.collectors || this.captureBytes + reservation > HISTORY_LIMITS.captureBytes ||
        this.queue.length + (this.inFlight?.count || 0) >= this.config.chatHistoryQueueCapacity || this.bytes >= this.config.chatHistoryQueueMaxBytes) {
      this.stats.activeDropped++; return null;
    }
    this.active++; this.captureBytes += reservation;
    const epoch = this.epoch;
    try {
      const collector = createCollector({ body, endpoint, ...options, config: this.config,
        enqueue: record => { if (epoch === this.epoch) this.enqueue(record); },
        release: () => { this.active--; this.captureBytes -= reservation; this.collectors.delete(collector); },
      });
      body = null; options = null;
      this.collectors.add(collector);
      return collector;
    } catch { this.active--; this.captureBytes -= reservation; this.stats.dropped++; return null; }
  }
  enqueue(record) {
    if (!this.config.chatHistoryEnabled) return false;
    if (this.queue.length + (this.inFlight?.count || 0) >= this.config.chatHistoryQueueCapacity || this.bytes >= this.config.chatHistoryQueueMaxBytes) { this.stats.dropped++; return false; }
    // Serialization is bounded by capture limits, never serializes the original body.
    let json;
    try { json = JSON.stringify(record); } catch { this.stats.dropped++; return false; }
    if (typeof json !== 'string') { this.stats.dropped++; return false; }
    const bytes = Buffer.byteLength(json);
    if (bytes > HISTORY_LIMITS.recordBytes || this.bytes + bytes > this.config.chatHistoryQueueMaxBytes) {
      this.stats.dropped++; return false;
    }
    // Own exactly `bytes` of backing storage, with no pooled slab or retained JSON string.
    let data;
    try { data = Buffer.allocUnsafeSlow(bytes); data.write(json, 'utf8'); }
    catch { this.stats.dropped++; return false; }
    this.queue.push({ data, bytes }); this.bytes += bytes;
    return true;
  }
  flush() {
    if (!this.config.chatHistoryEnabled || this.inFlight) return;
    this.ensureWorker();
    if (!this.ready || !this.queue.length) return;
    const batch = this.queue.splice(0, this.config.chatHistoryBatchSize);
    this.inFlight = { count: batch.length, bytes: batch.reduce((n, r) => n + r.bytes, 0) };
    try {
      // Transfer ownership; do not clone payloads. In-flight bytes stay charged until ACK.
      this.worker.postMessage({ type: 'batch', records: batch.map(r => r.data) }, batch.map(r => r.data.buffer));
      const worker = this.worker;
      this.watchdog = setTimeout(() => { this.fail(worker); worker.terminate().catch(() => {}); }, 5000);
      this.watchdog.unref?.();
    } catch { this.fail(this.worker); }
  }
  rpc(type, args = {}) {
    if (this.pending.size >= 32) return Promise.reject(new Error('History busy'));
    this.ensureWorker();
    if (!this.ready) return Promise.reject(new Error('History storage unavailable'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('History timeout')); }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ type, id, ...args }); } catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('History storage unavailable')); }
    });
  }
  metrics() { return { ...this.stats, queueDepth: this.queue.length + (this.inFlight?.count || 0), queueCapacity: this.config.chatHistoryQueueCapacity, queueBytes: this.bytes, queueMaxBytes: this.config.chatHistoryQueueMaxBytes, maxRecordBytes: HISTORY_LIMITS.recordBytes, active: this.active, captureReservedBytes: this.captureBytes, ready: !!this.ready }; }
  async close() {
    clearInterval(this.timer);
    for (const collector of this.collectors) collector.discard();
    this.flush();
    if (this.worker) {
      const worker = this.worker;
      let timeout;
      await Promise.race([this.rpc('close').catch(() => {}), new Promise(resolve => { timeout = setTimeout(resolve, 300); })]);
      clearTimeout(timeout);
      this.worker = null; this.ready = false;
      await worker.terminate();
    }
    clearTimeout(this.watchdog);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('History closed')); }
    this.pending.clear();
    this.stats.dropped += this.queue.length + (this.inFlight?.count || 0);
    this.queue = []; this.inFlight = null; this.bytes = 0;
  }
}

const state = globalThis.__chatHistoryService ||= new HistoryService();
export const chatHistory = state;
if (!globalThis.__chatHistoryShutdown) {
  globalThis.__chatHistoryShutdown = true;
  process.once('beforeExit', () => chatHistory.close().catch(() => {}));
}
// Weak keys neither retain requests nor change request/header/body contracts.
const observers = globalThis.__chatHistoryObservers ||= new WeakMap();
export function setHistoryObserver(request, collector) { if (collector) observers.set(request, collector); }
export function getHistoryObserver(request) { return request ? observers.get(request) : null; }
