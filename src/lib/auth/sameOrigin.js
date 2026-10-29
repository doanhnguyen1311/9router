// Next's server URL can use localhost internally. Validate browser mutations
// against the incoming Host instead; reverse proxies should preserve Host.
export function isSameOriginMutation(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const origin = request.headers.get('origin');
  if (!origin) return true; // CLI/API callers authenticate separately.
  try {
    const internal = new URL(request.url);
    const forwardedProto = request.headers.get('x-forwarded-proto');
    const protocol = forwardedProto === 'https' ? 'https:' : forwardedProto === 'http' ? 'http:' : internal.protocol;
    const authority = request.headers.get('host') || internal.host;
    if (!/^https?:$/.test(protocol) || /[\s/@\\?#]/.test(authority)) return false;
    const expected = new URL(`${protocol}//${authority}`).origin;
    return origin === expected;
  } catch {
    return false;
  }
}
