import { hashApiKey } from "@/lib/apiKeyStorage.js";

export function maskUsageApiKey(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("h1:")) return null;
  if (trimmed.length <= 12) return `${trimmed.charAt(0)}***`;
  return `${trimmed.slice(0, 8)}***${trimmed.slice(-4)}`;
}

export function usageApiKeyStorageKey(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^h1:[a-f0-9]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  const digest = hashApiKey(trimmed);
  return digest ? `h1:${digest}` : null;
}

export function isUsageApiKeyStorageKey(value) {
  return typeof value === "string" && /^h1:[a-f0-9]{64}$/i.test(value.trim());
}

export function safeStoredUsageKeyLabel(value, keyInfo = null) {
  if (!value || typeof value !== "string") return null;
  if (keyInfo?.masked) return keyInfo.masked;
  const trimmed = value.trim();
  if (isUsageApiKeyStorageKey(trimmed)) return `key-${trimmed.slice(3, 11)}`;
  return maskUsageApiKey(trimmed);
}

function addCounter(target, key, entry) {
  if (!target[key]) {
    target[key] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cost: 0,
      rawModel: entry.rawModel || "",
      provider: entry.provider || "",
      apiKeyMasked: entry.apiKeyMasked || null,
    };
  }
  target[key].requests += Number(entry.requests) || 0;
  target[key].promptTokens += Number(entry.promptTokens) || 0;
  target[key].completionTokens += Number(entry.completionTokens) || 0;
  target[key].cachedTokens += Number(entry.cachedTokens) || 0;
  target[key].cost += Number(entry.cost) || 0;
}

// Older usageDaily rows embedded the full API key both in the object property
// and in entry.apiKey. Normalize every read/import/migration so secrets never
// leave SQLite through a stats response and newly persisted rollups stay clean.
export function sanitizeUsageDailyData(day) {
  if (!day || typeof day !== "object" || Array.isArray(day)) return day;
  const sanitized = { ...day, byApiKey: {} };
  for (const [storedKey, rawEntry] of Object.entries(day.byApiKey || {})) {
    const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
    const rawModel = String(entry.rawModel || "");
    const provider = String(entry.provider || "unknown");
    let masked = typeof entry.apiKeyMasked === "string" ? entry.apiKeyMasked : null;
    if (!masked && typeof entry.apiKey === "string") masked = maskUsageApiKey(entry.apiKey);
    if (!masked && storedKey !== "local-no-key") {
      const suffix = `|${rawModel}|${provider}`;
      const candidate = storedKey.endsWith(suffix) ? storedKey.slice(0, -suffix.length) : storedKey.split("|")[0];
      masked = candidate.includes("***") || candidate.startsWith("key-")
        ? candidate
        : maskUsageApiKey(candidate);
    }
    const safeKey = masked ? `${masked}|${rawModel}|${provider}` : "local-no-key";
    addCounter(sanitized.byApiKey, safeKey, { ...entry, rawModel, provider, apiKeyMasked: masked });
  }
  return sanitized;
}
