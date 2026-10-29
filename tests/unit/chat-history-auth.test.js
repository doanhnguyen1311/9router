import { describe, it, expect, vi, beforeEach } from 'vitest';
const fx = vi.hoisted(() => ({ session: null, key: null, calls: [] }));
vi.mock('@/lib/auth/dashboardSession.js', () => ({ getDashboardAuthSession: async () => fx.session }));
vi.mock('@/lib/db/repos/apiKeysRepo.js', () => ({ getApiKeyByKey: async () => fx.key, getApiKeyNamesByIds: async () => [] }));
vi.mock('@/lib/chatHistory/service.js', () => ({ chatHistory: { rpc: async (type, args) => { fx.calls.push({ type, args }); return type === 'detail' ? null : { items: [], deleted: 0 }; }, metrics: () => ({ ready: true }) } }));
const { historyIdentity } = await import('../../src/lib/chatHistory/auth.js');
const { GET, DELETE } = await import('../../src/app/api/chat-history/route.js');
const req = (query = '', options = {}) => new Request('http://localhost/api/chat-history' + query, options);
beforeEach(() => { fx.session = null; fx.key = null; fx.calls = []; });
describe('history API authorization', () => {
  it('rejects anonymous access independently of the dashboard requireLogin setting', async () => {
    expect((await GET(req())).status).toBe(401); expect((await DELETE(req('?all=true', { method: 'DELETE' }))).status).toBe(401); expect(fx.calls).toHaveLength(0);
  });
  it('key owners are always scoped by backend identity, never query parameters', async () => {
    fx.key = { id: 'owner-a', isActive: true };
    const request = req('?ownerId=owner-b&admin=true&q=hello', { headers: { authorization: 'Bearer key' } });
    expect((await GET(request)).status).toBe(200);
    expect(fx.calls[0].args).toMatchObject({ admin: false, ownerId: 'owner-a', filters: { q: 'hello' } });
    expect((await GET(req('?id=other', { headers: { authorization: 'Bearer key' } }))).status).toBe(404);
    expect((await DELETE(req('?all=true', { method: 'DELETE', headers: { authorization: 'Bearer key' } }))).status).toBe(200);
    expect(fx.calls.at(-1).args).toMatchObject({ admin: false, ownerId: 'owner-a' });
  });
  it('disabled, unknown and expired keys are denied', async () => {
    for (const key of [null, { id: 'x', isActive: false }, { id: 'x', isActive: true, isExpired: true }]) {
      fx.key = key; expect((await GET(req('', { headers: { authorization: 'Bearer key' } }))).status).toBe(401);
    }
  });
  it('signed management sessions access all history; key cannot change global settings', async () => {
    fx.session = { authenticated: true }; expect(await historyIdentity(req(), true)).toEqual({ admin: true });
    fx.session = null; fx.key = { id: 'a', isActive: true };
    expect(await historyIdentity(req('', { headers: { authorization: 'Bearer key' } }), true)).toBeNull();
  });
  it('rejects cross-origin cookie mutations and bounds pagination/date filters', async () => {
    fx.session = { authenticated: true };
    expect((await DELETE(req('?all=true', { method: 'DELETE', headers: { origin: 'https://attacker.example' } }))).status).toBe(401);
    expect((await GET(req('?from=bad'))).status).toBe(400);
    const response = await GET(req('?limit=99999&offset=999999')); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fx.calls[0].args.limit).toBe(50); expect(fx.calls[0].args.offset).toBe(100000);
  });
});
