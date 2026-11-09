const WINDOW_MS = 60_000;
const READ_LIMIT = 600;
const WRITE_LIMIT = 120;

if (!global._projectApiRateLimits) global._projectApiRateLimits = new Map();
const buckets = global._projectApiRateLimits;

function prune(now) {
  if (buckets.size < 5000) return;
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}

export function consumeProjectApiBudget(principalId, request) {
  const now = Date.now();
  prune(now);
  const method = String(request?.method || "GET").toUpperCase();
  const mode = ["GET", "HEAD", "OPTIONS"].includes(method) ? "read" : "write";
  const limit = mode === "read" ? READ_LIMIT : WRITE_LIMIT;
  const key = `${principalId}:${mode}`;
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + WINDOW_MS };
  bucket.count += 1;
  buckets.set(key, bucket);
  if (bucket.count <= limit) return { allowed: true, remaining: limit - bucket.count, resetAt: bucket.resetAt };
  return { allowed: false, remaining: 0, resetAt: bucket.resetAt, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}

export const __test__ = { WINDOW_MS, READ_LIMIT, WRITE_LIMIT };
