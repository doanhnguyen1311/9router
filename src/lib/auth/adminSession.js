import { getDashboardAuthSession } from './dashboardSession.js';
import { isSameOriginMutation } from './sameOrigin.js';

// A management session is required even when requireLogin is disabled.
export async function hasAdminSession(request) {
  const cookie = (request.headers.get('cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith('auth_token='));
  const session = await getDashboardAuthSession(cookie?.slice('auth_token='.length));
  if (session?.authenticated !== true) return false;
  return isSameOriginMutation(request);
}
