import { describe, it, expect, afterEach, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { historyConfig, HISTORY_LIMITS } from '../../src/lib/chatHistory/config.js';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { HistoryService } from '../../src/lib/chatHistory/service.js';
import privacy from '../../src/lib/chatHistory/privacy.cjs';

const workerFile = fileURLToPath(new URL('../../src/lib/chatHistory/worker.cjs', import.meta.url));
const services = [], dirs = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 150; i++) { if (fn()) return; await pause(10); } throw new Error('Timed out'); }
async function service(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), '9r-history-')); dirs.push(dir);
  const file = path.join(dir, 'history.sqlite');
  const s = new HistoryService({ file, workerFactory: () => new Worker(workerFile, { workerData: { file } }) });
  services.push(s); s.configure({ chatHistoryEnabled: true, ...extra });
  await until(() => s.ready); return s;
}
async function flush(s) { s.flush(); await until(() => !s.inFlight); }
const body = { model: 'test/model', messages: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hello' }, { role: 'tool', tool_call_id: 't1', content: 'result' }] };
async function collect(s, response, owner = 'a', b = body) {
  const c = s.begin(b, '/v1/chat/completions'); expect(c).not.toBeNull(); c.identify(owner); c.attempt('test', 'model');
  const wrapped = c.wrap(response); const text = await wrapped.text(); await flush(s); return { text, c };
}
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('bounded asynchronous chat history', () => {
  it('persists successful full request messages, usage and exact response bytes', async () => {
    const s = await service();
    const json = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'world' } }], usage: { prompt_tokens: 8, completion_tokens: 3 } });
    expect((await collect(s, new Response(json, { headers: { 'content-type': 'application/json', 'x-test': 'kept' } }))).text).toBe(json);
    const list = await s.rpc('list', { ownerId: 'a' });
    const detail = await s.rpc('detail', { ownerId: 'a', recordId: list.items[0].id });
    expect(detail.request.messages.map(m => m.role)).toEqual(['system', 'user', 'tool']);
    expect(detail.response[0].content).toBe('world'); expect(detail.inputTokens).toBe(8); expect(detail.outputTokens).toBe(3);
  });
  it('preserves fragmented UTF8 SSE and assembles tool calls without modifying headers/chunks', async () => {
    const s = await service();
    const frames = [
      { choices: [{ delta: { content: 'Tiếng Việt' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'read', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] } }], usage: { prompt_tokens: 2, completion_tokens: 5 } },
    ];
    const raw = frames.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(raw);
    let index = 0;
    const stream = new ReadableStream({ pull(c) { if (index < bytes.length) c.enqueue(bytes.slice(index, ++index)); else c.close(); } });
    const c = s.begin(body, '/v1/messages'); c.identify('a');
    const wrapped = c.wrap(new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'x-test': 'ok' } }));
    expect(wrapped.headers.get('x-test')).toBe('ok'); expect(await wrapped.text()).toBe(raw); await flush(s);
    const list = await s.rpc('list', { ownerId: 'a' }); const d = await s.rpc('detail', { ownerId: 'a', recordId: list.items[0].id });
    expect(d.response[0].content).toBe('Tiếng Việt'); expect(d.response[0].tool_calls[0].function.arguments).toBe('{"path":"a"}');
  });
  it('retains the latest user prompt when a large system prompt would exhaust capture', async () => {
    const s = await service();
    const request = { model: 'test/model', messages: [
      { role: 'system', content: 'instructions '.repeat(100000) },
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'bạn là ai vậy' },
    ] };
    await collect(s, Response.json({ choices: [{ message: { role: 'assistant', content: 'Trợ lý lập trình trong VS Code.' } }] }), 'a', request);
    const row = (await s.rpc('list', { ownerId: 'a' })).items[0];
    const detail = await s.rpc('detail', { ownerId: 'a', recordId: row.id });
    expect(row.title).toBe('bạn là ai vậy');
    expect(detail.request.messages.at(-1)).toEqual({ role: 'user', content: 'bạn là ai vậy' });
    expect(detail.response[0].content).toBe('Trợ lý lập trình trong VS Code.');
    expect(detail.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(detail.request))).toBeLessThan(32768);
  });
  it('bounds traversal of long context and preserves Responses/Gemini user input', () => {
    const reordered = privacy.sanitizeRequest({ messages: [{ content: 'x'.repeat(100000), role: 'system' }, { content: 'latest question', role: 'user' }] }, 4096);
    expect(reordered.value.messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(reordered.value.messages[1].content).toBe('latest question');
    for (const key of ['input', 'contents']) {
      const fields = { instructions: 'system '.repeat(100000), [key]: Array.from({ length: 10000 }, (_, i) => ({ role: i === 9999 ? 'user' : 'assistant', ...(key === 'contents' ? { parts: [{ text: i === 9999 ? 'latest question' : 'old' }] } : { content: i === 9999 ? 'latest question' : 'old' }) })) };
      const result = privacy.sanitizeRequest(fields, 32768);
      expect(result.value[key].length).toBeLessThanOrEqual(HISTORY_LIMITS.requestMessages);
      expect(JSON.stringify(result.value[key].at(-1))).toContain('latest question');
      expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThan(32768);
      expect(result.truncated).toBe(true);
    }
  });
  it('keeps Responses reasoning separate from the final answer and assembles named tool calls', async () => {
    const s = await service();
    const frames = [
      { type: 'response.reasoning_summary_text.delta', delta: 'reasoning summary' },
      { type: 'response.output_text.delta', delta: 'final answer' },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'read_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"path":"a"}' },
      { type: 'response.completed', response: { status: 'completed' } },
    ];
    await collect(s, new Response(frames.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } }));
    const row = (await s.rpc('list', { ownerId: 'a' })).items[0];
    const detail = await s.rpc('detail', { ownerId: 'a', recordId: row.id });
    expect(detail.response[0].content).toBe('final answer');
    expect(detail.response[0].reasoning_content).toBe('reasoning summary');
    expect(detail.response[0].tool_calls[0]).toMatchObject({ name: 'read_file', id: 'call1', arguments: '{"path":"a"}' });
  });
  it('records HTTP failures and in-band SSE failures with sanitized diagnostics', async () => {
    const s = await service();
    await collect(s, Response.json({ error: { code: 'rate_limit', message: 'Authorization: Bearer sk-supersecretvalue' } }, { status: 429 }));
    await collect(s, new Response('data: {"error":{"message":"stream timeout","code":504}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const rows = (await s.rpc('list', { admin: true })).items;
    expect(rows.map(r => r.status).sort()).toEqual(['failed', 'timeout']);
    for (const row of rows) expect(JSON.stringify(await s.rpc('detail', { admin: true, recordId: row.id }))).not.toContain('sk-supersecretvalue');
  });
  it('detects a clean EOF without a terminal SSE event as interrupted', async () => {
    const s = await service();
    await collect(s, new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    expect((await s.rpc('list', { admin: true })).items[0].status).toBe('interrupted');
  });
  it('keeps concurrent attempt statuses associated with their own selection', async () => {
    const s = await service(); const c = s.begin(body, '/v1');
    const first = c.attempt('a', 'one'), second = c.attempt('b', 'two');
    c.result(second, 200); c.result(first, 429);
    await c.wrap(new Response('ok')).text(); await flush(s);
    const row = (await s.rpc('list', { admin: true })).items[0]; const d = await s.rpc('detail', { admin: true, recordId: row.id });
    expect(d.attempts.map(a => a.httpStatus)).toEqual([429, 200]);
  });
  it('queue full drops newest and never changes the successful response', async () => {
    const s = await service({ chatHistoryQueueCapacity: 1 });
    const c1 = s.begin(body, '/v1'); await c1.wrap(new Response('one')).text();
    const c2 = s.begin(body, '/v1'); expect(c2).toBeNull();
    expect(await (c2?.wrap(new Response('two')) || new Response('two')).text()).toBe('two');
    expect(s.queue).toHaveLength(1); expect(s.stats.activeDropped).toBe(1);
  });
  it('DB busy and malformed records do not poison the worker or block proxy responses', async () => {
    const s = await service(); const db = new DatabaseSync(s.file); db.exec('BEGIN IMMEDIATE');
    const c = s.begin(body, '/v1'); expect(await c.wrap(new Response('ok')).text()).toBe('ok');
    await flush(s); expect(s.stats.dropped).toBe(1); db.exec('ROLLBACK'); db.close();
    s.enqueue({ invalid: true }); await flush(s);
    await collect(s, Response.json({ choices: [{ message: { content: 'recovered' } }] }));
    expect((await s.rpc('list', { admin: true })).items).toHaveLength(1);
  });
  it('disabled never traverses content; disabling discards active capture and queued data', async () => {
    const s = await service(); const c = s.begin(body, '/v1');
    s.configure({ chatHistoryEnabled: false });
    expect(await c.wrap(new Response('ok')).text()).toBe('ok'); expect(s.queue).toHaveLength(0); expect(s.active).toBe(0);
    const malicious = new Proxy({}, { get() { throw new Error('must not access'); } });
    expect(s.begin(malicious, '/v1')).toBeNull();
  });
  it('retention deletes old history on config/periodic maintenance, preserving fresh data', async () => {
    const s = await service();
    for (const age of [31, 1]) s.enqueue({ id: 'age-' + age, ownerId: 'a', createdAt: new Date(Date.now() - age * 86400000).toISOString(), status: 'success', request: {}, responsePrefix: '' });
    await flush(s); s.worker.postMessage({ type: 'config', config: s.config });
    const list = await s.rpc('list', { admin: true }); expect(list.items.map(r => r.id)).toEqual(['age-1']);
  });
  it('startup honors a configured retention longer than 30 days', async () => {
    const s = await service({ chatHistoryRetentionDays: 365 });
    s.enqueue({ id: 'keep-60-days', ownerId: 'a', createdAt: new Date(Date.now() - 60 * 86400000).toISOString(), status: 'success', request: {}, responsePrefix: '' });
    await flush(s); const file = s.file; await s.close(); services.splice(services.indexOf(s), 1);
    const restarted = new HistoryService({ file, workerFactory: () => new Worker(workerFile, { workerData: { file } }) });
    services.push(restarted); restarted.configure({ chatHistoryEnabled: true, chatHistoryRetentionDays: 365 }); await until(() => restarted.ready);
    expect((await restarted.rpc('list', { admin: true })).items.map(r => r.id)).toEqual(['keep-60-days']);
  });
  it('captures native Claude and Responses tool events and redacts secrets spanning deltas', async () => {
    const s = await service();
    const frames = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { partial_json: '{"path":"a"}' } },
      { type: 'content_block_delta', index: 1, delta: { text: 'sk-super' } },
      { type: 'content_block_delta', index: 1, delta: { text: 'secretvalue' } },
      { type: 'message_delta', usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    await collect(s, new Response(frames.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } }));
    const rows = await s.rpc('list', { admin: true }); const d = await s.rpc('detail', { admin: true, recordId: rows.items[0].id });
    expect(d.response[0].tool_calls[0]).toMatchObject({ id: 't1', name: 'read', input: '{"path":"a"}' });
    expect(JSON.stringify(d)).not.toContain('sk-supersecretvalue'); expect(d.response[0].content).toBe('[REDACTED]');
    expect(d.outputTokens).toBe(5);
  });
  it('owner cannot list, search, read or delete another owner, including unowned records', async () => {
    const s = await service(); await collect(s, Response.json({ content: 'owner A secret' }), 'a'); await collect(s, new Response('b'), 'b'); await collect(s, new Response('local'), null);
    const a = (await s.rpc('list', { ownerId: 'a' })).items[0];
    expect((await s.rpc('list', { ownerId: 'b', filters: { q: 'owner A secret' } })).items).toEqual([]);
    expect(await s.rpc('detail', { ownerId: 'b', recordId: a.id })).toBeNull();
    expect((await s.rpc('delete', { ownerId: 'b', recordId: a.id })).deleted).toBe(0);
    expect((await s.rpc('list', { admin: true })).items).toHaveLength(3);
    await expect(s.rpc('list')).rejects.toThrow();
  });
  it('bounds huge requests, response capture, active collectors, queue bytes and binary', async () => {
    const s = await service({ chatHistoryMaxContentBytes: 4096, chatHistoryQueueMaxBytes: 65536 });
    const huge = { model: 'a', messages: [{ role: 'user', content: 'x'.repeat(10_000_000), image_url: { url: 'data:image/png;base64,' + 'A'.repeat(1_000_000) } }] };
    const c = s.begin(huge, '/v1'); expect(await c.wrap(new Response('y'.repeat(1_000_000))).text()).toHaveLength(1_000_000);
    expect(s.bytes).toBeLessThanOrEqual(65536); expect(s.queue[0].data.byteLength).toBeLessThan(16000);
    const captures = Array.from({ length: 100 }, () => s.begin(body, '/v1'));
    expect(captures.filter(Boolean).length).toBe(32); captures.forEach(c => c?.discard()); expect(s.active).toBe(0);
  });
  it('observes cancel, transport interruption and abort exactly once, and propagates cancel', async () => {
    const s = await service(); const cancel = vi.fn();
    const c = s.begin(body, '/v1'); const source = new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode('partial')); }, cancel });
    const controller = new AbortController(); const reader = c.wrap(new Response(source), controller.signal).body.getReader();
    await reader.read(); controller.abort(); await reader.cancel(); expect(cancel).toHaveBeenCalledOnce(); expect(s.queue).toHaveLength(1);
    const c2 = s.begin(body, '/v1'); const broken = new ReadableStream({ pull(controller) { controller.error(new Error('network')); } });
    await expect(c2.wrap(new Response(broken)).text()).rejects.toThrow('network'); await flush(s);
    expect((await s.rpc('list', { admin: true })).items.map(r => r.status).sort()).toEqual(['aborted', 'interrupted']);
  });
  it('a crashed worker drops pending data and capture fails open', async () => {
    const s = await service(); await s.worker.terminate(); await until(() => !s.ready);
    expect(s.begin(body, '/v1')).toBeNull(); expect(s.metrics().errors).toBeGreaterThan(0);
  });
  it('removes known opaque credentials and restricts SQLite/sidecar file permissions', async () => {
    const s = await service();
    const c = s.begin({ model: 'm', messages: [{ role: 'user', content: 'client-opaque-value' }] }, '/v1', { secret: 'client-opaque-value' });
    c.protect('provider-opaque-value');
    await c.wrap(Response.json({ choices: [{ message: { content: 'provider-opaque-value' } }] })).text(); await flush(s);
    const row = (await s.rpc('list', { admin: true })).items[0]; const d = await s.rpc('detail', { admin: true, recordId: row.id });
    expect(JSON.stringify(d)).not.toContain('client-opaque-value'); expect(JSON.stringify(d)).not.toContain('provider-opaque-value');
    if (process.platform !== 'win32') for (const suffix of ['', '-wal', '-shm']) expect(statSync(s.file + suffix).mode & 0o077).toBe(0);
  });
  it('redacts credential fields, URLs, common token patterns and embedded binaries', () => {
    const raw = { api_key: 'private', text: 'Bearer xyz password=abc sk-abcdefghijkl https://example.org/?key=secret', inlineData: { data: 'A'.repeat(1e6) }, nested: { accessToken: 'xyz' } };
    const cleaned = JSON.stringify(privacy.sanitize(raw).value);
    for (const value of ['private', 'Bearer xyz', 'password=abc', 'sk-abcdefghijkl', 'example.org', 'accessToken":"xyz']) expect(cleaned).not.toContain(value);
    expect(cleaned).toContain('BINARY OMITTED');
  });
});


// Hold acknowledgements so queue/in-flight accounting can be tested deterministically.
class ControlledWorker extends EventEmitter {
  messages = [];
  constructor() { super(); queueMicrotask(() => this.emit('message', { type: 'ready' })); }
  postMessage(message, transfer = []) {
    this.messages.push(structuredClone(message, { transfer }));
    if (message.type === 'close') queueMicrotask(() => this.emit('message', { id: message.id, result: true }));
  }
  unref() {}
  async terminate() { this.emit('exit', 0); }
}
async function controlledService(settings = {}) {
  const worker = new ControlledWorker();
  const s = new HistoryService({ workerFactory: () => worker }); services.push(s);
  s.configure({ chatHistoryEnabled: true, ...settings }); await until(() => s.ready);
  return { s, worker };
}

describe('hard memory limits and buffer ownership', () => {
  it('clamps old/oversized configuration to 50 records, 16 MiB, batch 10 and 2 seconds', () => {
    expect(historyConfig({ chatHistoryQueueCapacity: 1000, chatHistoryQueueMaxBytes: 32 * 1024 * 1024, chatHistoryBatchSize: 1, chatHistoryFlushIntervalMs: 100 })).toMatchObject({
      chatHistoryQueueCapacity: 50, chatHistoryQueueMaxBytes: 16 * 1024 * 1024, chatHistoryBatchSize: 10, chatHistoryFlushIntervalMs: 2000,
    });
    expect(HISTORY_LIMITS.recordBytes).toBe(512 * 1024);
  });
  it('charges exact UTF-8 JSON bytes and owns no pooled storage or duplicate JSON string', async () => {
    const { s } = await controlledService();
    const record = { text: '\u0000"\\😀漢字 Tiếng Việt'.repeat(300) };
    const json = JSON.stringify(record), bytes = Buffer.byteLength(json);
    expect(s.enqueue(record)).toBe(true);
    expect(s.metrics().queueBytes).toBe(bytes);
    expect(s.queue[0].data.buffer.byteLength).toBe(bytes);
    expect(s.queue[0].data.toString('utf8')).toBe(json);
    expect(s.queue[0]).not.toHaveProperty('json');
  });
  it('admits exactly 50, drops newest without traversal, and counts in-flight records/bytes', async () => {
    const { s, worker } = await controlledService();
    for (let id = 0; id < 50; id++) expect(s.enqueue({ id, text: 'hello' })).toBe(true);
    const touched = vi.fn(() => { throw new Error('must not serialize'); });
    const rejected = new Proxy({}, { get: touched });
    expect(s.enqueue(rejected)).toBe(false); expect(touched).not.toHaveBeenCalled();
    const originalBytes = s.bytes, firstBatchBytes = s.queue.slice(0, 10).reduce((n, r) => n + r.bytes, 0);
    const moved = s.queue[0].data;
    s.flush();
    expect(moved.byteLength).toBe(0); // real transfer, not a structured-clone copy
    expect(s.queue).toHaveLength(40); expect(s.inFlight.count).toBe(10);
    expect(s.metrics()).toMatchObject({ queueDepth: 50, queueBytes: originalBytes, dropped: 1 });
    expect(s.enqueue(rejected)).toBe(false); expect(touched).not.toHaveBeenCalled();
    s.flush(); expect(worker.messages.filter(m => m.type === 'batch')).toHaveLength(1);
    worker.emit('message', { type: 'batch', saved: 10, dropped: 0 });
    expect(s.metrics()).toMatchObject({ queueDepth: 40, queueBytes: originalBytes - firstBatchBytes });
    s.flush();
    const next = worker.messages.filter(m => m.type === 'batch')[1];
    expect(JSON.parse(Buffer.from(next.records[0]).toString()).id).toBe(10);
    worker.emit('message', { type: 'batch', saved: 10, dropped: 0 });
  });
  it('accepts a 512 KiB record, rejects 512 KiB + 1, and stops at exactly 16 MiB', async () => {
    const { s, worker } = await controlledService();
    const overhead = Buffer.byteLength(JSON.stringify({ content: '' }));
    const record = { content: 'x'.repeat(HISTORY_LIMITS.recordBytes - overhead) };
    expect(s.enqueue({ content: record.content + 'x' })).toBe(false);
    for (let i = 0; i < 32; i++) expect(s.enqueue(record)).toBe(true);
    expect(s.bytes).toBe(16 * 1024 * 1024); expect(s.queue).toHaveLength(32);
    expect(s.enqueue({ tiny: true })).toBe(false);
    const touched = vi.fn(() => { throw new Error('must not collect'); });
    expect(s.begin(new Proxy({}, { get: touched }), '/v1')).toBeNull(); expect(touched).not.toHaveBeenCalled();
    s.flush(); expect(s.metrics().queueBytes).toBe(16 * 1024 * 1024);
    worker.emit('message', { type: 'batch', saved: 0, dropped: 10 });
    expect(s.bytes).toBe(22 * 512 * 1024); expect(s.stats.dropped).toBe(12);
    s.flush(); // failed batch was discarded; only the next ten are sent
    expect(worker.messages.filter(m => m.type === 'batch')).toHaveLength(2);
    worker.emit('message', { type: 'batch', saved: 10, dropped: 0 });
  });
  it('reserves capture memory at admission and releases the original reservation after config changes', async () => {
    const { s } = await controlledService();
    const small = s.begin(body, '/v1'); const reserved = s.metrics().captureReservedBytes;
    s.configure({ chatHistoryEnabled: true, chatHistoryMaxContentBytes: 256 * 1024 });
    const large = s.begin(body, '/v1');
    expect(s.metrics().captureReservedBytes).toBeGreaterThan(reserved);
    large.discard(); expect(s.metrics().captureReservedBytes).toBe(reserved);
    const more = Array.from({ length: 32 }, () => s.begin(body, '/v1'));
    expect(more.filter(Boolean).length).toBeLessThan(32); expect(s.captureBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    more.forEach(c => c?.discard()); small.discard();
    expect(s.metrics()).toMatchObject({ active: 0, captureReservedBytes: 0 });
  });
  it('releases stream readers/listeners on completion and on discard without changing forwarding', async () => {
    const { s } = await controlledService(); const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const response = new Response('done'); const source = response.body;
    const c = s.begin(body, '/v1'); expect(await c.wrap(response, abort.signal).text()).toBe('done');
    expect(source.locked).toBe(false); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(s.metrics()).toMatchObject({ active: 0, captureReservedBytes: 0 });
    const abort2 = new AbortController(); const remove2 = vi.spyOn(abort2.signal, 'removeEventListener');
    const c2 = s.begin(body, '/v1'); const response2 = new Response('still forwarded'); const source2 = response2.body;
    const wrapped = c2.wrap(response2, abort2.signal); c2.discard();
    expect(remove2).toHaveBeenCalled(); expect(await wrapped.text()).toBe('still forwarded'); expect(source2.locked).toBe(false);
  });
  it('bounds escaping, metadata and request keys during capture before serializing a completed record', async () => {
    const { s } = await controlledService({ chatHistoryMaxContentBytes: 256 * 1024 });
    const requestBody = { model: 'm', messages: [{ role: 'user', content: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => ['field_' + i + '_'.repeat(80), '\u0000\n'.repeat(100)])) }] };
    const c = s.begin(requestBody, '/v1'); expect(c).not.toBeNull();
    for (let i = 0; i < 32; i++) c.attempt('p'.repeat(1_000_000), 'm'.repeat(1_000_000));
    const wrapped = c.wrap(new Response(Buffer.alloc(2 * 1024 * 1024, 0)));
    const reader = wrapped.body.getReader();
    while (!(await reader.read()).done) { /* discard client bytes */ }
    expect(s.queue).toHaveLength(1); expect(s.queue[0].bytes).toBeLessThanOrEqual(512 * 1024);
    const record = JSON.parse(s.queue[0].data.toString());
    expect(Buffer.byteLength(JSON.stringify(record.request))).toBeLessThanOrEqual(128 * 1024);
    expect(record.attempts).toHaveLength(16); expect(record.model.length).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(record.responsePrefix) * 6 + 8192 * 6 + 128 * 1024 + 65536).toBeLessThanOrEqual(512 * 1024);
    expect(s.metrics()).toMatchObject({ active: 0, captureReservedBytes: 0 });
  });
  it('keeps prefix/tail capture bounded over a long fragmented stream', async () => {
    const { s } = await controlledService({ chatHistoryMaxContentBytes: 4096 });
    let chunks = 0;
    const prefix = 'data: {"choices":[{"delta":{"content":"start"}}]}\n\n';
    const terminal = 'data: {"usage":{"prompt_tokens":2,"completion_tokens":8}}\n\ndata: [DONE]\n\n';
    const response = new Response(new ReadableStream({ pull(controller) {
      if (chunks === 0) controller.enqueue(Buffer.from(prefix));
      else if (chunks <= 10000) controller.enqueue(Buffer.from('1234567890'));
      else if (chunks === 10001) controller.enqueue(Buffer.from(terminal));
      else controller.close();
      chunks++;
    } }), { headers: { 'content-type': 'text/event-stream' } });
    const c = s.begin(body, '/v1'); const reader = c.wrap(response).body.getReader();
    let total = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; }
    expect(total).toBe(Buffer.byteLength(prefix) + 100000 + Buffer.byteLength(terminal));
    const raw = JSON.parse(s.queue[0].data.toString());
    expect(Buffer.byteLength(raw.responsePrefix)).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(raw.responseTail)).toBeLessThanOrEqual(8192);
    expect(raw.responseTail).toContain('[DONE]'); expect(raw.truncated).toBe(true);
    expect(s.metrics()).toMatchObject({ active: 0, captureReservedBytes: 0 });
  });
});
