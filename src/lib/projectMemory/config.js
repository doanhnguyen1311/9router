export const PROJECT_PRINCIPAL_LOCAL = "local-admin";

export function isProjectAdminPrincipal(principalId) {
  if (principalId === PROJECT_PRINCIPAL_LOCAL) return true;
  const configured = String(process.env.PROJECT_ADMIN_PRINCIPALS || "")
    .split(",").map((item) => item.trim()).filter(Boolean);
  return configured.includes(principalId);
}

export const PROJECT_ROLES = Object.freeze(["owner", "editor", "viewer"]);
export const PROJECT_STATUSES = Object.freeze(["active", "locked", "archived"]);
export const MEMORY_STATUSES = Object.freeze(["active", "superseded", "rejected", "pinned", "archived"]);
export const MEMORY_TYPES = Object.freeze([
  "project", "architecture", "entity", "relationship", "decision", "task",
  "constraint", "technical_fact", "file", "dependency", "issue", "resolution",
]);

export const PROJECT_DEFAULTS = Object.freeze({
  contextTokenBudget: 1800,
  maxGraphDepth: 2,
});

export const FILE_LIMITS = Object.freeze({
  maxPathLength: 500,
  maxArchiveEntries: 5000,
  maxArchiveBytes: 64 * 1024 * 1024,
  maxArchiveExpandedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxStoredContentBytes: 512 * 1024,
  maxSymbolsPerFile: 2000,
  maxDependenciesPerFile: 2000,
});

export const DEFAULT_IGNORE_PARTS = Object.freeze([
  "node_modules", ".git", "dist", "build", "coverage", "vendor", "cache",
  ".cache", ".next", "__pycache__", ".venv", "target",
]);

export const SECRET_FILE_PATTERNS = Object.freeze([
  /^\.env(?:\..+)?$/i,
  /(?:^|[._-])credentials?(?:[._-]|$)/i,
  /(?:^|[._-])secrets?(?:[._-]|$)/i,
  /(?:^|[._-])id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
]);

export function normalizeProjectName(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 120) return null;
  return normalized;
}

export function normalizeDescription(value) {
  if (value == null) return "";
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= 4000 ? normalized : null;
}

export function normalizePrincipal(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) return null;
  return normalized;
}

export function intInRange(value, min, max, fallback) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
