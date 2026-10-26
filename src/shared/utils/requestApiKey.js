// Read a client-facing 9Router API key in the same order as dashboardGuard.
// Provider credentials are never sourced through this helper.
export function extractClientApiKey(request) {
  const headers = request?.headers;
  if (!headers?.get) return null;
  const auth = headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const xApiKey = headers.get("x-api-key");
  if (xApiKey) return xApiKey;
  const googleApiKey = headers.get("x-goog-api-key");
  if (googleApiKey) return googleApiKey;
  try {
    return new URL(request.url).searchParams.get("key") || null;
  } catch {
    return null;
  }
}
