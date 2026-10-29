import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fx = vi.hoisted(() => ({ enabled: true, base: process.env.HISTORY_TEST_UPSTREAM, service: null }));
vi.mock('@/lib/localDb', () => ({
  getSettings: async () => ({ requireApiKey: true, chatHistoryEnabled: fx.enabled, rtkEnabled: false }),
  getModelAliases: async () => ({}), getProviderNodes: async () => [], getComboByName: async name => name === 'fallback' ? { name, models: ['openai-compatible-history/rate-limited', 'openai-compatible-history/model'] } : null,
}));
vi.mock('@/sse/services/auth.js', () => ({
  getProviderCredentials: async (_p, excluded) => excluded.size ? null : { connectionId: 'fixture', apiKey: 'upstream-fixture', providerSpecificData: { baseUrl: fx.base } },
  markAccountUnavailable: async () => ({ shouldFallback: true }), clearAccountError: async () => {}, extractApiKey: r => r.headers.get('authorization')?.slice(7), isValidApiKey: async () => true,
}));
vi.mock('@/sse/services/keyAccess.js', () => ({
  getKeyAccessContext: async (_request, identity) => { identity?.({ id: 'key-a', isActive: true }); return null; },
  getAllowedConnectionIds: () => undefined, enforceKeyAccess: async () => null, filterAdapterModels: async (_c, m) => m, resolveKeyModelRequest: (_c, m) => m,
}));
vi.mock('@/sse/services/apiKeyQuota.js', () => ({ enforceApiKeyQuota: async () => null }));
vi.mock('@/sse/services/tokenRefresh.js', () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: async () => {} }));
vi.mock('@/lib/usageDb.js', () => ({ trackPendingRequest: () => {}, appendRequestLog: async () => {}, saveRequestDetail: async () => {}, saveRequestUsage: async () => {} }));
vi.mock('@/lib/chatHistory/service.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, chatHistory: { begin: (...args) => fx.enabled ? fx.service.begin(...args) : null } };
});
const { handleChat } = await import('../../src/sse/handlers/chat.js');
const { HistoryService } = await import('../../src/lib/chatHistory/service.js');
const { initTranslators } = await import('../../open-sse/translator/index.js');
let dir;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await pause(10); } throw new Error('History timeout'); }
function request(model, stream, endpoint = 'chat/completions', messages = [{ role: 'user', content: 'hi' }]) {
  return new Request('http://localhost/v1/' + endpoint, { method: 'POST', headers: { authorization: 'Bearer fixture' }, body: JSON.stringify({ model, stream, messages }) });
}
describe.skipIf(!fx.base)('real chat handler/core/executor/translation over HTTP', () => {
  beforeAll(async () => {
    await initTranslators(); dir = mkdtempSync(path.join(tmpdir(), '9r-history-proxy-'));
    const file = path.join(dir, 'history.sqlite');
    fx.service = new HistoryService({ file, workerFactory: () => new Worker(fileURLToPath(new URL('../../src/lib/chatHistory/worker.cjs', import.meta.url)), { workerData: { file } }) });
    fx.service.configure({ chatHistoryEnabled: true }); await waitFor(() => fx.service.ready);
  });
  afterAll(async () => { if (fx.service) await fx.service.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  it('fallback after 429 produces one logical history record with two attempts', async () => {
    const r = await handleChat(request('fallback', true)); expect(r.status).toBe(200);
    const text = await r.text(); expect(text).toContain('hello '); expect(text).toContain('[DONE]');
    fx.service.flush(); await waitFor(() => !fx.service.inFlight);
    const rows = await fx.service.rpc('list', { ownerId: 'key-a' }); expect(rows.items).toHaveLength(1);
    const detail = await fx.service.rpc('detail', { ownerId: 'key-a', recordId: rows.items[0].id });
    expect(detail.attempts.map(a => a.httpStatus)).toEqual([429, 200]); expect(detail.status).toBe('success');
  });
  it('history on/off preserves JSON responses for OpenAI, Anthropic and Responses endpoints', async () => {
    for (const endpoint of ['chat/completions', 'messages', 'responses']) {
      const values = [];
      for (const enabled of [false, true]) {
        fx.enabled = enabled;
        const r = await handleChat(request('openai-compatible-history/model', false, endpoint));
        expect(r.status).toBe(200); const b = await r.json(); delete b.id; delete b.created_at; delete b.created; values.push(b);
      }
      expect(values[1]).toEqual(values[0]);
    }
  });

  it.skipIf(!process.env.HISTORY_BENCH)('reports local on/off proxy streaming benchmark', async () => {
    const samples = { disabled: [], enabled: [] };
    fx.service.configure({ chatHistoryEnabled: true, chatHistoryQueueCapacity: 50 });
    const memory = { disabled: [], enabled: [] }, cpu = { disabled: 0, enabled: 0 };
    for (let n = 0; n < 120; n++) {
      for (const enabled of n % 2 ? [true, false] : [false, true]) {
        fx.enabled = enabled;
        const mode = enabled ? 'enabled' : 'disabled';
        const cpuStart = process.cpuUsage(); const started = performance.now();
        const r = await handleChat(request('openai-compatible-history/model', true));
        const reader = r.body.getReader(); let ttft = null, bytes = 0;
        while (true) {
          const result = await reader.read(); if (result.done) break;
          ttft ??= performance.now() - started; bytes += result.value.byteLength;
        }
        const latency = performance.now() - started;
        const used = process.cpuUsage(cpuStart);
        if (n >= 20) {
          samples[mode].push({ latency, ttft, bytes }); cpu[mode] += used.user + used.system;
          memory[mode].push(process.memoryUsage().rss / 1048576);
        }
      }
      if (n % 10 === 0) { fx.service.flush(); await waitFor(() => !fx.service.inFlight); }
    }
    const percentile = (a, q) => [...a].sort((a,b) => a-b)[Math.floor((a.length-1)*q)];
    const result = {};
    for (const [mode, a] of Object.entries(samples)) result[mode] = {
      requests: a.length, latencyP50Ms: percentile(a.map(x => x.latency), .5), latencyP95Ms: percentile(a.map(x => x.latency), .95),
      ttftP50Ms: percentile(a.map(x => x.ttft), .5), ttftP95Ms: percentile(a.map(x => x.ttft), .95),
      streamKiBPerSec: a.reduce((v,x) => v+x.bytes,0) / 1024 / (a.reduce((v,x) => v+x.latency,0) / 1000),
      cpuMs: cpu[mode] / 1000, peakRssMiB: Math.max(...memory[mode]),
    };
    result.metrics = fx.service.metrics();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.HISTORY_BENCH_OUTPUT || '/tmp/9router-history-benchmark.json', JSON.stringify(result, null, 2));
    expect(result.metrics.dropped).toBe(0);
  }, 30000);
  it('upstream failure retains the HTTP contract and creates a failed history record', async () => {
    fx.enabled = true;
    const r = await handleChat(request('openai-compatible-history/rate-limited', false)); expect(r.status).toBe(429);
    expect(await r.text()).toContain('Rate limit'); fx.service.flush(); await waitFor(() => !fx.service.inFlight);
    const failed = await fx.service.rpc('list', { ownerId: 'key-a', filters: { status: 'failed' } }); expect(failed.items.length).toBeGreaterThan(0);
  });
});
