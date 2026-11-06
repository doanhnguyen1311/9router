import crypto from "node:crypto";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";
import { loadJwtSecret } from "@/lib/auth/persistentSecret.js";

const CIPHER_VERSION = "v2e1";
const CIPHER_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 8192;

function encryptionKey(machineId) {
  const applicationSecret = loadJwtSecret();
  return crypto
    .createHash("sha256")
    .update("9router:v2-upstream-credential\0")
    .update(applicationSecret)
    .update("\0")
    .update(String(machineId || ""))
    .digest();
}

export function normalizeV2UpstreamBaseUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim() || rawUrl.length > MAX_ENDPOINT_LENGTH) {
    throw new Error("Invalid v2 upstream endpoint");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("Invalid v2 upstream endpoint");
  }

  if (parsed.protocol !== "https:") throw new Error("V2 upstream endpoint must use HTTPS");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("V2 upstream endpoint must be a base URL without credentials, query, or fragment");
  }

  // Reject obvious private/metadata targets at write time. DNS and redirect
  // targets are checked again immediately before every outbound request.
  assertPublicUrl(parsed);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

export function validateV2ProxyInput(input) {
  if (input === undefined || input === null) {
    return { ok: true, value: { enabled: false, upstreamBaseUrl: null, upstreamApiKey: null } };
  }
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.enabled !== "boolean") {
    return { ok: false, error: "Invalid v2 proxy configuration" };
  }
  if (!input.enabled) {
    return { ok: true, value: { enabled: false, upstreamBaseUrl: null, upstreamApiKey: null } };
  }

  const upstreamApiKey = typeof input.upstreamApiKey === "string" ? input.upstreamApiKey.trim() : "";
  if (!upstreamApiKey || upstreamApiKey.length > MAX_API_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(upstreamApiKey)) {
    return { ok: false, error: "Invalid v2 upstream API key" };
  }

  try {
    return {
      ok: true,
      value: {
        enabled: true,
        upstreamBaseUrl: normalizeV2UpstreamBaseUrl(input.upstreamBaseUrl),
        upstreamApiKey,
      },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function encryptV2UpstreamApiKey(apiKey, machineId) {
  if (typeof apiKey !== "string" || !apiKey) throw new Error("Invalid v2 upstream API key");
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, encryptionKey(machineId), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CIPHER_VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptV2UpstreamApiKey(encrypted, machineId) {
  try {
    const [version, ivRaw, tagRaw, ciphertextRaw, extra] = String(encrypted || "").split(".");
    if (version !== CIPHER_VERSION || !ivRaw || !tagRaw || !ciphertextRaw || extra !== undefined) return null;
    const iv = Buffer.from(ivRaw, "base64url");
    const tag = Buffer.from(tagRaw, "base64url");
    const ciphertext = Buffer.from(ciphertextRaw, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16 || ciphertext.length === 0) return null;
    const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, encryptionKey(machineId), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8") || null;
  } catch {
    return null;
  }
}

export function isEncryptedV2UpstreamApiKey(value) {
  return typeof value === "string" && value.startsWith(`${CIPHER_VERSION}.`) && value.split(".").length === 4;
}

export function v2ProxySummaryFromRow(row) {
  const enabled = row?.v2Enabled === 1 || row?.v2Enabled === true;
  return {
    enabled,
    configured: enabled && typeof row?.v2UpstreamBaseUrl === "string" && !!row.v2UpstreamBaseUrl
      && isEncryptedV2UpstreamApiKey(row?.v2UpstreamApiKeyEncrypted),
  };
}
