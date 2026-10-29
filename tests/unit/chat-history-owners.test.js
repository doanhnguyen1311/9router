import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

const fx = vi.hoisted(() => ({ db: null, identity: null, records: [], queries: [], fail: false }));
vi.mock('../../src/lib/db/driver.js', () => ({ getAdapter: async () => ({ all: (sql, params) => {
  fx.queries.push({ sql, params });
  if (fx.fail) throw new Error('simulated database error');
  return fx.db.prepare(sql).all(...params);
} }) }));
vi.mock('@/lib/chatHistory/auth.js', () => ({ historyIdentity: async () => fx.identity }));
vi.mock('@/lib/chatHistory/service.js', () => ({ chatHistory: {
  rpc: async (type, args) => {
    const allowed = fx.records.filter(record => args.admin || record.ownerId === args.ownerId);
    return type === 'detail' ? allowed.find(record => record.id === args.recordId) || null : { items: allowed, hasMore: false, limit: 20, offset: 0 };
  }, metrics: () => ({ ready: true }),
} }));
const { GET } = await import('@/app/api/chat-history/route.js');
const { getApiKeyNamesByIds } = await import('@/lib/db/repos/apiKeysRepo.js');
const req = query => new Request('http://localhost/api/chat-history' + (query || ''));

beforeEach(() => {
  fx.db = new DatabaseSync(':memory:');
  fx.db.exec('CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT, name TEXT)');
  const insert = fx.db.prepare('INSERT INTO apiKeys VALUES (?, ?, ?)');
  insert.run('owner-a', 'sk-private-credential-a', 'Doanh · Copilot');
  insert.run('owner-b', 'sk-private-credential-b', 'Teammate B');
  fx.identity = { admin: true }; fx.queries = []; fx.fail = false;
  fx.records = [
    { id: 'request-a', ownerId: 'owner-a', status: 'success' },
    { id: 'request-b', ownerId: 'owner-b', status: 'success' },
    { id: 'request-deleted', ownerId: 'deleted-id', status: 'success' },
    { id: 'request-local', ownerId: null, status: 'failed' },
  ];
});
afterEach(() => fx.db.close());

describe('history API key owner labels', () => {
  it('resolves the API key name in lists and detail without exposing credentials', async () => {
    const list = await (await GET(req())).json();
    expect(list.items[0].apiKey).toEqual({ id: 'owner-a', name: 'Doanh · Copilot', state: 'identified' });
    expect(list.items[1].apiKey.name).toBe('Teammate B');
    expect(JSON.stringify(list)).not.toContain('sk-private-credential');
    const detail = await (await GET(req('?id=request-a'))).json();
    expect(detail.apiKey).toEqual(list.items[0].apiKey);
    expect(fx.queries).toHaveLength(2);
    expect(fx.queries[0].sql).toContain('substr(name, 1, 200)');
    expect(fx.queries[0].sql).not.toContain('SELECT *');
  });
  it('looks up names only inside the authenticated owner scope', async () => {
    fx.identity = { admin: false, ownerId: 'owner-a' };
    const result = await (await GET(req('?ownerId=owner-b&admin=true'))).json();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].apiKey.name).toBe('Doanh · Copilot');
    expect(JSON.stringify(result)).not.toContain('Teammate B');
    expect(fx.queries[0].params).toEqual(['owner-a']);
    fx.queries = [];
    expect((await GET(req('?id=request-b'))).status).toBe(404);
    expect(fx.queries).toHaveLength(0);
    fx.identity = null;
    expect((await GET(req())).status).toBe(401);
    expect(fx.queries).toHaveLength(0);
  });
  it('distinguishes a deleted key from a request with no identified key', async () => {
    const result = await (await GET(req())).json();
    expect(result.items[2].apiKey).toEqual({ id: 'deleted-id', name: null, state: 'deleted' });
    expect(result.items[3].apiKey).toEqual({ id: null, name: null, state: 'unidentified' });
  });
  it('reflects renamed keys, handles unnamed keys and bounds/redacts display names', async () => {
    fx.db.prepare('UPDATE apiKeys SET name = ? WHERE id = ?').run('Renamed ' + 'x'.repeat(1000), 'owner-a');
    fx.db.prepare('UPDATE apiKeys SET name = ? WHERE id = ?').run('  ', 'owner-b');
    let result = await (await GET(req())).json();
    expect(result.items[0].apiKey.name.startsWith('Renamed ')).toBe(true);
    expect(result.items[0].apiKey.name.length).toBeLessThanOrEqual(200);
    expect(result.items[1].apiKey).toMatchObject({ name: null, state: 'identified' });
    fx.db.prepare('UPDATE apiKeys SET name = ? WHERE id = ?').run('Bearer sk-accidentallypastedsecret', 'owner-a');
    result = await (await GET(req('?id=request-a'))).json();
    expect(result.apiKey.name).not.toContain('accidentallypastedsecret');
  });
  it('still returns the conversation if key-name lookup is temporarily unavailable', async () => {
    fx.fail = true;
    const response = await GET(req());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.items[0].apiKey).toEqual({ id: 'owner-a', name: null, state: 'unavailable' });
    expect(result.items[3].apiKey.state).toBe('unidentified');
  });
  it('bounds metadata queries and parameterizes IDs', async () => {
    const rows = await getApiKeyNamesByIds(['owner-a', 'owner-a', null, {}, "owner-a' OR 1=1 --", ...Array.from({ length: 80 }, (_, i) => 'other-' + i)]);
    expect(rows).toEqual([{ id: 'owner-a', name: 'Doanh · Copilot' }]);
    expect(fx.queries[0].params).toHaveLength(50);
    expect(fx.queries[0].sql).not.toContain('OR 1=1');
    expect(rows[0]).not.toHaveProperty('key');
  });
});
