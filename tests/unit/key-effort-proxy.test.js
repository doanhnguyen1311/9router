import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import '../translator/registerAll.js';
const fx = vi.hoisted(() => ({ base: process.env.HISTORY_TEST_UPSTREAM, policy: { allowUserChoice: false, effort: 'high', overrides: [] }, authCalls: 0 }));
vi.mock('@/lib/localDb', () => ({
  getSettings: async () => ({ requireApiKey: true, providerThinking: { kilocode: { mode: 'max' } }, rtkEnabled: false }),
  getModelAliases: async () => ({}), getProviderNodes: async () => [],
  getComboByName: async name => name === 'effort-combo' ? { name, models: ['kc/moonshotai/kimi-k3(max)', 'kc/openai/gpt-5.4(max)'] } : name === 'retry-combo' ? { name, models: ['kc/openai/gpt-5.1(max)', 'kc/openai/gpt-5.4(low)'] } : null,
}));
vi.mock('@/lib/db/repos/apiKeysRepo.js', () => ({ getApiKeyByKey: async key => ({ id: key, isActive: true, access: { restricted: false, accountRestricted: false }, effortPolicy: key === 'low-key' ? { allowUserChoice: false, effort: 'low', overrides: [] } : fx.policy }) }));
vi.mock('@/sse/services/auth.js', () => ({
  getProviderCredentials: async (_p, excluded) => { fx.authCalls++; return excluded.size ? null : { connectionId: 'fixture', apiKey: 'fake-upstream', providerSpecificData: {} }; },
  markAccountUnavailable: async () => ({ shouldFallback: true }), clearAccountError: async () => {}, extractApiKey: r => r.headers.get('authorization')?.slice(7), isValidApiKey: async () => true,
}));
vi.mock('@/sse/services/apiKeyQuota.js', () => ({ enforceApiKeyQuota: async () => null }));
vi.mock('@/sse/services/tokenRefresh.js', () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: async () => {} }));
vi.mock('@/lib/usageDb.js', () => ({ trackPendingRequest: () => {}, appendRequestLog: async () => {}, saveRequestDetail: async () => {}, saveRequestUsage: async () => {} }));
vi.mock('@/lib/chatHistory/service.js', () => ({ chatHistory: { begin: () => null }, getHistoryObserver: () => null, setHistoryObserver: () => {} }));
const { handleChat } = await import('../../src/sse/handlers/chat.js');
const { PROVIDERS } = await import('../../open-sse/config/providers.js');
const original = { ...PROVIDERS.kilocode };
function request(model, extra = {}, key = 'high-key', endpoint = 'chat/completions') {
  return new Request('http://localhost/v1/' + endpoint, { method: 'POST', headers: { authorization: 'Bearer ' + key, ...(endpoint === 'responses' ? { 'user-agent': 'codex-cli/test' } : {}) }, body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: 'hello' }], ...extra }) });
}
describe.skipIf(!fx.base)('key effort real HTTP routing and fallback', () => {
  beforeAll(() => { PROVIDERS.kilocode.baseUrl = fx.base + '/chat/completions'; PROVIDERS.kilocode.retry = { '429': { attempts: 0, delayMs: 0 } }; });
  afterAll(() => Object.assign(PROVIDERS.kilocode, original));
  it('isolates concurrent keys while provider default and client suffix/body ask for max', async () => {
    fx.policy = { allowUserChoice: false, effort: 'high', overrides: [] };
    const responses = await Promise.all(['low-key', 'high-key'].map(key => handleChat(request('kc/openai/gpt-5.4(max)', { reasoning_effort: 'max', reasoning: { effort: 'max' } }, key))));
    const bodies = await Promise.all(responses.map(r => r.json()));
    expect(bodies.map(b => b.choices[0].message.content)).toEqual(['effort:low', 'effort:high']);
  });
  it('respects nested client effort when access is allowed instead of injecting provider max', async () => {
    fx.policy = { allowUserChoice: true, effort: null, overrides: [] };
    const r = await handleChat(request('kc/openai/gpt-5.4', { reasoning: { effort: 'low' } })); expect(r.status).toBe(200);
    const b = await r.json(); expect(b.choices[0].message.content).toBe('effort:low');
  });
  it('rechecks each combo member and skips an unsupported medium before credential selection', async () => {
    fx.policy = { allowUserChoice: false, effort: 'medium', overrides: [] }; fx.authCalls = 0;
    const r = await handleChat(request('effort-combo', { stream: true })); expect(r.status).toBe(200);
    const stream = await r.text(); expect(stream).toContain('effort:medium'); expect(stream).toContain('[DONE]');
    expect(fx.authCalls).toBe(1);
  });
  it('keeps locked high after a 429 account/model fallback and preserves SSE framing', async () => {
    fx.policy = { allowUserChoice: false, effort: 'high', overrides: [] };
    const r = await handleChat(request('retry-combo', { stream: true })); expect(r.status).toBe(200);
    const stream = await r.text(); expect(stream).toContain('data: '); expect(stream).toContain('effort:high'); expect(stream).toContain('[DONE]');
  }, 15000);
  it('applies admin model overrides even when the default is incompatible with Kimi', async () => {
    fx.policy = { allowUserChoice: false, effort: 'medium', overrides: [{ model: 'kilocode/moonshotai/kimi-k3', effort: 'low' }] };
    const r = await handleChat(request('kc/moonshotai/kimi-k3(max)')); expect(r.status).toBe(200);
    expect((await r.json()).choices[0].message.content).toBe('effort:low');
  });
  it('blocks opaque Responses state rather than bypassing a lock using cached updates', async () => {
    fx.policy = { allowUserChoice: false, effort: 'high', overrides: [] };
    const r = await handleChat(request('kc/openai/gpt-5.4', { input: 'hello', previous_response_id: 'stored' }, 'high-key', 'responses'));
    expect(r.status).toBe(400); expect(await r.text()).toContain('explicit conversation');
  });
});
