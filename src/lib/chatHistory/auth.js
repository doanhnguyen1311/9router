import { getDashboardAuthSession } from '@/lib/auth/dashboardSession.js';
import { getApiKeyByKey } from '@/lib/db/repos/apiKeysRepo.js';
import { extractClientApiKey } from '@/shared/utils/requestApiKey.js';
import { isSameOriginMutation } from '@/lib/auth/sameOrigin.js';

export async function historyIdentity(request, adminOnly = false) {
  const cookie = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith('auth_token='));
  const session = await getDashboardAuthSession(cookie?.slice('auth_token='.length));
  // Existing dashboard sessions are management sessions (no per-user roles in 9Router).
  if (session?.authenticated === true) {
    if (!isSameOriginMutation(request)) return null;
    return { admin: true };
  }
  if (adminOnly) return null;
  const key = extractClientApiKey(request);
  if (!key) return null;
  const record = await getApiKeyByKey(key);
  if (!record?.isActive || record.isExpired) return null;
  return { admin: false, ownerId: record.id };
}
