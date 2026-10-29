import { hasAdminSession } from '@/lib/auth/adminSession.js';
import { getModelInfo } from '@/sse/services/model.js';
import { getEffortCapabilities, normalizeEffortModel } from 'open-sse/providers/effortCapabilities.js';

export const dynamic = 'force-dynamic';
export async function GET(request) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!(await hasAdminSession(request))) return Response.json({ error: 'Admin session required' }, { status: 401, headers });
  const target = new URL(request.url).searchParams.get('model');
  if (!target || target.length > 256) return Response.json({ error: 'model is required (max 256 characters)' }, { status: 400, headers });
  const { provider, model } = await getModelInfo(normalizeEffortModel(target));
  if (!provider) return Response.json({ error: 'Select a concrete model, not a combo' }, { status: 400, headers });
  return Response.json({ model: `${provider}/${normalizeEffortModel(model)}`, ...getEffortCapabilities(provider, model) }, { headers });
}
