import { describe, it, expect, vi, beforeEach } from 'vitest';
const fx = vi.hoisted(() => ({ admin: false, policy: { allowUserChoice: true, effort: null, overrides: [] }, reject: false, updates: [] }));
vi.mock('@/lib/auth/adminSession.js', () => ({ hasAdminSession: async () => fx.admin }));
vi.mock('@/lib/localDb', () => ({
  getApiKeyById: async () => ({ id: 'a', effortPolicy: fx.policy }),
  getApiKeyByKey: async key => key === 'a-key' ? { id: 'a', isActive: true, effortPolicy: fx.policy, modelRouting: {}, access: {} } : null,
  updateApiKey: async (id, data) => { if (fx.reject) throw Object.assign(new Error('revoked'), { code: 'KEY_EFFORT_FORBIDDEN' }); fx.updates.push({ id, data }); return { id, access: { restricted: false, allow: [] }, modelRouting: {}, effortPolicy: data.effortPolicy || { ...fx.policy, effort: data.selectedEffort } }; },
}));
vi.mock('@/lib/usageDb.js', () => ({ getApiKeyUsageSummary: async () => ({ effortPolicy: fx.policy }) }));
vi.mock('@/sse/services/model.js', () => ({ getModelInfo: async target => { const i = target.indexOf('/'); const p = target.slice(0, i); return { provider: p === 'cx' ? 'codex' : p, model: target.slice(i + 1) }; } }));
const { PUT } = await import('@/app/api/keys/[id]/route.js');
const { PATCH } = await import('@/app/api/key-usage/route.js');
const { GET: capabilities } = await import('@/app/api/keys/[id]/effort/route.js');
const req = (body, key = 'a-key') => new Request('http://localhost/api/key-usage', { method: 'PATCH', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = body => PUT(new Request('http://localhost/api/keys/a', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'a' }) });
beforeEach(() => { fx.admin = false; fx.policy = { allowUserChoice: true, effort: null, overrides: [] }; fx.reject = false; fx.updates = []; });
describe('effort management authorization', () => {
  it('requires an actual admin session to set access/locked values', async () => {
    expect((await put({ effortPolicy: { allowUserChoice: false, effort: 'high' } })).status).toBe(401); expect(fx.updates).toEqual([]);
    fx.admin = true;
    expect((await put({ effortPolicy: { allowUserChoice: false, effort: 'high', overrides: [{ model: 'cx/gpt-6.1-sol', effort: 'low' }] } })).status).toBe(200);
    expect(fx.updates[0].data.effortPolicy.overrides).toEqual([{ model: 'codex/gpt-6.1-sol', effort: 'low' }]);
    expect((await put({ effortPolicy: { allowUserChoice: false, effort: 'high', overrides: [{ model: 'cx/gpt-6.1-sol[1m](max)', effort: 'low' }] } })).status).toBe(200);
    expect(fx.updates.at(-1).data.effortPolicy.overrides).toEqual([{ model: 'codex/gpt-6.1-sol', effort: 'low' }]);
  });
  it('rejects unsupported overrides, duplicate aliases and invalid locked policies', async () => {
    fx.admin = true;
    for (const policy of [{ allowUserChoice: false }, { allowUserChoice: false, effort: 'ultra' }, { allowUserChoice: false, effort: 'high', overrides: [{ model: 'kimi/kimi-k3', effort: 'medium' }] }, { allowUserChoice: false, effort: 'high', overrides: [{ model: 'codex/gpt-6.1-sol', effort: 'low' }, { model: 'cx/gpt-6.1-sol', effort: 'max' }] }]) expect((await put({ effortPolicy: policy })).status).toBe(400);
    expect(fx.updates).toEqual([]);
  });
  it('scopes self-service to the presented key and refuses policy escalation', async () => {
    expect((await PATCH(req({ selectedEffort: 'low' }))).status).toBe(200);
    expect(fx.updates).toEqual([{ id: 'a', data: { selectedEffort: 'low' } }]);
    expect((await PATCH(req({ effortPolicy: { allowUserChoice: true } }))).status).toBe(400);
    expect((await PATCH(req({ selectedEffort: 'max' }, 'other'))).status).toBe(401);
  });
  it('rejects self-selection while locked and handles revocation at write time', async () => {
    fx.policy = { allowUserChoice: false, effort: 'high' };
    expect((await PATCH(req({ selectedEffort: 'low' }))).status).toBe(403); expect(fx.updates).toEqual([]);
    fx.policy = { allowUserChoice: true, effort: null }; fx.reject = true;
    expect((await PATCH(req({ selectedEffort: 'max' }))).status).toBe(403);
  });
  it('protects the capabilities route and returns only verified options', async () => {
    const request = new Request('http://localhost/api/keys/a/effort?model=cx/gpt-6.1-sol');
    expect((await capabilities(request)).status).toBe(401); fx.admin = true;
    const r = await capabilities(request); expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toMatchObject({ model: 'codex/gpt-6.1-sol', levels: ['low', 'medium', 'high', 'xhigh', 'max'] });
  });
});
