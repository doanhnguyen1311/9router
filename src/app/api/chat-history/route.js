import { historyIdentity } from '@/lib/chatHistory/auth.js';
import { chatHistory } from '@/lib/chatHistory/service.js';
import { getApiKeyNamesByIds } from '@/lib/db/repos/apiKeysRepo.js';
import privacy from '@/lib/chatHistory/privacy.cjs';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (data, status = 200) => Response.json(data, { status, headers });
let lastOwnerWarning = 0;

async function withApiKeyNames(records) {
  // Resolve names only AFTER the History worker has applied the caller's scope.
  // This runs on Dashboard reads, never in the inference/capture path.
  const ids = records.map(record => record.ownerId).filter(Boolean);
  let names = new Map(), available = true;
  if (ids.length) {
    try { names = new Map((await getApiKeyNamesByIds(ids)).map(key => [key.id, key.name])); }
    catch {
      available = false;
      if (Date.now() - lastOwnerWarning > 60000) { lastOwnerWarning = Date.now(); console.warn('[ChatHistory] API key names temporarily unavailable'); }
    }
  }
  return records.map(record => {
    const id = record.ownerId || null;
    const state = !id ? 'unidentified' : !available ? 'unavailable' : names.has(id) ? 'identified' : 'deleted';
    const rawName = id && names.get(id);
    const name = typeof rawName === 'string' ? privacy.sanitize(rawName, 2048).value.replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;
    return { ...record, apiKey: { id, name, state } };
  });
}

function query(request) {
  const p = new URL(request.url).searchParams;
  const filters = {};
  for (const key of ['q', 'model', 'provider', 'status']) {
    if (p.get(key)) filters[key] = p.get(key).slice(0, 200);
  }
  for (const key of ['from', 'to']) {
    if (p.get(key)) {
      const time = Date.parse(p.get(key));
      if (!Number.isFinite(time)) throw new Error('Invalid date');
      filters[key] = new Date(time).toISOString();
    }
  }
  return { filters, limit: Math.max(1, Math.min(50, Number(p.get('limit')) || 20)), offset: Math.max(0, Math.min(100000, Number(p.get('offset')) || 0)) };
}

export async function GET(request) {
  const identity = await historyIdentity(request);
  if (!identity) return reply({ error: 'Authentication required' }, 401);
  let args;
  try { args = query(request); } catch { return reply({ error: 'Invalid date filter' }, 400); }
  const id = new URL(request.url).searchParams.get('id');
  if (id && id.length > 100) return reply({ error: 'Invalid ID' }, 400);
  try {
    const result = await chatHistory.rpc(id ? 'detail' : 'list', { ...identity, ...args, recordId: id });
    if (id) return result ? reply((await withApiKeyNames([result]))[0]) : reply({ error: 'Not found' }, 404);
    return reply({ ...result, items: await withApiKeyNames(result.items), ...(identity.admin ? { metrics: chatHistory.metrics() } : {}) });
  } catch { return reply({ error: 'History temporarily unavailable' }, 503); }
}

export async function DELETE(request) {
  const identity = await historyIdentity(request);
  if (!identity) return reply({ error: 'Authentication required' }, 401);
  const p = new URL(request.url).searchParams;
  const recordId = p.get('id');
  if (!recordId && p.get('all') !== 'true') return reply({ error: 'Specify id or all=true' }, 400);
  if (recordId?.length > 100) return reply({ error: 'Invalid ID' }, 400);
  try {
    const result = await chatHistory.rpc('delete', { ...identity, recordId });
    return reply({ ...result, more: !recordId && result.deleted === 100 });
  } catch { return reply({ error: 'History temporarily unavailable' }, 503); }
}
