const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { sanitize } = require('./privacy.cjs');
const limits = require('./limits.cjs');
let db, config = null, lastWarning = 0;
function warn() {
  if (Date.now() - lastWarning > 60000) { console.warn('[ChatHistory] storage operation failed; record dropped'); lastWarning = Date.now(); }
}
function init() {
  fs.mkdirSync(path.dirname(workerData.file), { recursive: true });
  // Set permissions before SQLite creates WAL/SHM (sidecars inherit DB mode).
  fs.closeSync(fs.openSync(workerData.file, 'a', 0o600));
  fs.chmodSync(workerData.file, 0o600);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.chmodSync(workerData.file + suffix, 0o600); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Dedicated native connection, all synchronous SQLite work stays in this thread.
  // Fail open if no WAL-capable driver exists; never share sql.js's exported file.
  if (process.versions.bun) {
    const { Database } = require('bun:sqlite'); db = new Database(workerData.file, { create: true });
  } else {
    try { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(workerData.file); }
    catch {
      if (Number(process.versions.node.split('.')[0]) >= 24) throw new Error('No native SQLite');
      const Database = require('better-sqlite3'); db = new Database(workerData.file);
    }
  }
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=100; PRAGMA cache_size=-2048;');
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version > 1) throw new Error('Unsupported history schema');
  // Additive migration v1. No access to existing gateway tables or usage logs.
  db.exec(`CREATE TABLE IF NOT EXISTS historyRequests (
    id TEXT PRIMARY KEY, ownerId TEXT, createdAt TEXT NOT NULL, model TEXT, provider TEXT,
    status TEXT NOT NULL, httpStatus INTEGER, inputTokens INTEGER, outputTokens INTEGER,
    title TEXT, searchText TEXT, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_owner_time ON historyRequests(ownerId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_history_time ON historyRequests(createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_history_model_time ON historyRequests(model, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_history_provider_time ON historyRequests(provider, createdAt DESC);
  PRAGMA user_version=1;`);
  try { fs.chmodSync(workerData.file, 0o600); } catch { /* platform may not support modes */ }
}
function normalize(record) {
  const prefix = record.responsePrefix || '', tail = record.responseTail || '';
  delete record.responsePrefix; delete record.responseTail;
  const events = [];
  let terminal = /data:\s*\[DONE\]/.test(prefix + tail);
  const parse = text => { try { return JSON.parse(text); } catch { return null; } };
  if (record.sse) {
    for (const text of [prefix, tail]) for (const line of text.split('\n')) {
      if (line.startsWith('data:')) { const e = parse(line.slice(5).trim()); if (e) events.push(e); }
    }
  } else { const value = parse(prefix); if (value) events.push(value); }
  const response = [];
  let assistant = '', reasoning = '', tools = new Map();
  for (const e of events) {
    const data = e.response || e.message || e;
    if (['message_stop', 'response.completed', 'response.failed', 'response.incomplete'].includes(e.type) || data.choices?.some(c => c.finish_reason != null) || data.candidates?.some(c => c.finishReason)) terminal = true;
    const usage = data.usage || e.usage || data.usageMetadata;
    if (usage) {
      record.inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount ?? record.inputTokens;
      record.outputTokens = usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount ?? record.outputTokens;
    }
    if (data.model) record.responseModel = data.model;
    const error = e.error || data.error;
    if (data.status === 'incomplete' || data.status === 'failed') record.status = 'failed';
    if (error || ['response.failed', 'response.incomplete', 'error'].includes(e.type)) {
      record.status = /timeout|timed out|stall/i.test(String(error?.message || '')) ? 'timeout' : 'failed';
      record.error = { category: record.status, code: error?.code || error?.type, message: error?.message || 'Stream failed' };
    }
    const choice = data.choices?.[0];
    if (choice?.message) response.push(choice.message);
    if (typeof choice?.delta?.content === 'string') assistant += choice.delta.content;
    if (typeof choice?.delta?.reasoning_content === 'string') reasoning += choice.delta.reasoning_content;
    for (const tc of choice?.delta?.tool_calls || []) {
      const index = tc.index ?? 0;
      const tool = tools.get(index) || { type: 'function', id: '', function: { name: '', arguments: '' } };
      if (tc.id) tool.id = tc.id;
      if (tc.function?.name) tool.function.name += tc.function.name;
      if (tc.function?.arguments) tool.function.arguments += tc.function.arguments;
      tools.set(index, tool);
    }
    // Reassemble native text/tool deltas before redaction (secrets can span events).
    let nativeDelta = false;
    if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
      tools.set('claude-' + e.index, { type: 'tool_use', id: e.content_block.id, name: e.content_block.name, input: '' }); nativeDelta = true;
    }
    if (e.type === 'content_block_delta') {
      if (e.delta?.text) assistant += e.delta.text;
      if (e.delta?.thinking) reasoning += e.delta.thinking;
      if (e.delta?.partial_json) { const tool = tools.get('claude-' + e.index); if (tool) tool.input += e.delta.partial_json; }
      nativeDelta = true;
    }
    if (e.type === 'response.output_text.delta') { assistant += e.delta || ''; nativeDelta = true; }
    if (e.type === 'response.reasoning_summary_text.delta') { reasoning += e.delta || ''; nativeDelta = true; }
    if (['response.output_item.added', 'response.output_item.done'].includes(e.type) && e.item?.type === 'function_call') {
      const key = 'responses-' + (e.item.id || e.output_index);
      const tool = tools.get(key) || { type: 'function_call', arguments: '' };
      tool.id = e.item.call_id || e.item.id; tool.name = e.item.name;
      if (e.item.arguments) tool.arguments = e.item.arguments;
      tools.set(key, tool);
    }
    if (e.type === 'response.function_call_arguments.delta') {
      const key = 'responses-' + (e.item_id || e.output_index);
      const tool = tools.get(key) || { type: 'function_call', id: e.item_id, arguments: '' };
      tool.arguments += e.delta || ''; tools.set(key, tool); nativeDelta = true;
    }
    // Preserve completed protocol-native blocks, tool results and reasoning.
    if (!nativeDelta && !choice && !(e.type === 'response.completed' && record.sse && !record.truncated)) response.push(e);
  }
  if (assistant || reasoning || tools.size) response.unshift({ role: 'assistant', content: assistant, ...(reasoning ? { reasoning_content: reasoning } : {}), tool_calls: [...tools.values()] });
  if (!events.length && prefix) response.push({ content: prefix, partial: true });
  record.response = response;
  if (record.sse && record.status === 'success' && !terminal) {
    record.status = 'interrupted'; record.error = { category: 'stream', message: 'Stream ended without a completion marker' };
  }
  const category = record.status === 'timeout' || record.httpStatus === 504 ? 'timeout' : record.httpStatus === 429 ? 'rate_limit' : record.httpStatus >= 500 ? 'provider' : record.httpStatus === 404 ? 'routing' : record.status;
  if (record.error) { record.error.category = category; record.error.httpStatus = record.httpStatus; }
  if (record.httpStatus >= 400 && !record.error) record.error = { category, code: record.httpStatus, httpStatus: record.httpStatus, message: 'Request failed' };
  // A final bounded pass catches secrets split across streaming deltas.
  const cleaned = sanitize(record, 3 * 256 * 1024);
  return cleaned.value;
}
function write(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > limits.recordBytes) throw new Error('Invalid history record size');
  const raw = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
  const record = normalize(raw);
  const data = JSON.stringify(record);
  if (Buffer.byteLength(data) > limits.recordBytes) throw new Error('Normalized record too large');
  const searchText = data.slice(0, 100000);
  const messages = record.request?.messages || record.request?.input || record.request?.contents;
  const user = Array.isArray(messages) ? messages.findLast(message => message?.role === 'user') : null;
  const content = user?.content ?? user?.parts ?? (typeof record.request?.input === 'string' ? record.request.input : null);
  const title = (typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text || '').join('') : '') || record.requestedModel || 'Request';
  db.prepare(`INSERT OR IGNORE INTO historyRequests(id,ownerId,createdAt,model,provider,status,httpStatus,inputTokens,outputTokens,title,searchText,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(raw.id, raw.ownerId, raw.createdAt, record.model || record.requestedModel || null, record.provider || null,
      record.status, record.httpStatus || null, record.inputTokens ?? null, record.outputTokens ?? null,
      (typeof title === 'string' ? title : 'Request').slice(0, 160), searchText, data);
}
function scope(args) {
  const clauses = [], params = [];
  if (!args.admin) { if (!args.ownerId) throw new Error('Identity required'); clauses.push('ownerId = ?'); params.push(args.ownerId); }
  return { clauses, params };
}
function query(args) {
  const { clauses, params } = scope(args);
  const f = args.filters || {};
  for (const key of ['model', 'provider', 'status']) if (f[key]) { clauses.push(`${key} = ?`); params.push(f[key]); }
  if (f.q) { clauses.push('instr(searchText, ?) > 0'); params.push(f.q); }
  if (f.from) { clauses.push('createdAt >= ?'); params.push(f.from); }
  if (f.to) { clauses.push('createdAt <= ?'); params.push(f.to); }
  if (args.recordId) { clauses.push('id = ?'); params.push(args.recordId); }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  return { where, params };
}
function cleanup() {
  if (!config) return;
  try {
    const cutoff = new Date(Date.now() - config.chatHistoryRetentionDays * 86400000).toISOString();
    db.prepare('DELETE FROM historyRequests WHERE id IN (SELECT id FROM historyRequests WHERE createdAt < ? ORDER BY createdAt LIMIT 100)').run(cutoff);
  } catch { warn(); }
}
try {
  init();
  const timer = setInterval(cleanup, 60000); timer.unref();
  parentPort.on('message', args => {
    try {
      if (args.type === 'config') { config = args.config; cleanup(); return; }
      if (args.type === 'batch') {
        let saved = 0, dropped = 0;
        for (const json of args.records.slice(0, limits.batchRecords)) { try { write(json); saved++; } catch { dropped++; warn(); } }
        parentPort.postMessage({ type: 'batch', saved, dropped }); return;
      }
      if (args.type === 'close') { clearInterval(timer); db.close(); parentPort.postMessage({ id: args.id, result: true }); return; }
      const { where, params } = query(args);
      let result;
      if (args.type === 'list') {
        const limit = Math.max(1, Math.min(50, args.limit || 20)), offset = Math.max(0, Math.min(100000, args.offset || 0));
        const rows = db.prepare(`SELECT id,ownerId,createdAt,model,provider,status,httpStatus,inputTokens,outputTokens,title FROM historyRequests${where} ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?`).all(...params, limit + 1, offset);
        result = { items: rows.slice(0, limit), hasMore: rows.length > limit, offset, limit };
      } else if (args.type === 'detail') {
        const row = db.prepare(`SELECT data FROM historyRequests${where} LIMIT 1`).get(...params); result = row ? JSON.parse(row.data) : null;
      } else if (args.type === 'delete') {
        // Batch deletion bounds lock duration even for an admin deleting all.
        const r = db.prepare(`DELETE FROM historyRequests WHERE id IN (SELECT id FROM historyRequests${where} LIMIT 100)`).run(...params);
        result = { deleted: Number(r.changes) };
      } else throw new Error('Unknown operation');
      parentPort.postMessage({ id: args.id, result });
    } catch { warn(); parentPort.postMessage({ id: args.id, error: true }); }
  });
  parentPort.postMessage({ type: 'ready' });
} catch { warn(); process.exitCode = 1; }
