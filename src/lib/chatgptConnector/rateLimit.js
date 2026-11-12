const buckets = new Map();

export function consumeConnectorRateLimit(key, { limit, windowMs = 60_000, now = Date.now() }) {
  const bucketKey = String(key || "unknown").slice(0, 500);
  let bucket = buckets.get(bucketKey);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(bucketKey, bucket);
  }
  bucket.count += 1;
  if (buckets.size > 5000) {
    for (const [candidate, value] of buckets) if (now >= value.resetAt) buckets.delete(candidate);
  }
  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

export function resetConnectorRateLimits() {
  buckets.clear();
}
