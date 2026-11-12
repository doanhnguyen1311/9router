import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { redactProjectText } from "@/lib/projectMemory/privacy.js";
import { CHATGPT_CONNECTOR_LIMITS } from "./constants.js";

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function base64UrlSha256(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createOpaqueToken(prefix) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function normalizePairingCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8);
}

export function createPairingCode() {
  const bytes = randomBytes(8);
  let raw = "";
  for (const byte of bytes) raw += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
  return { raw, display: `${raw.slice(0, 4)}-${raw.slice(4)}`, hash: sha256(raw) };
}

function sanitizeValue(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return redactProjectText(value.slice(0, CHATGPT_CONNECTOR_LIMITS.maxToolResultChars)).text;
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 500)) {
      if (/token|secret|password|credential|pairingcodehash|noncehash/i.test(key)) continue;
      output[key] = sanitizeValue(item, depth + 1);
    }
    return output;
  }
  return value;
}

export function sanitizeConnectorData(value) {
  const clean = sanitizeValue(value);
  const serialized = JSON.stringify(clean);
  if (serialized.length <= CHATGPT_CONNECTOR_LIMITS.maxToolResultChars) return clean;
  return {
    truncated: true,
    preview: redactProjectText(serialized.slice(0, CHATGPT_CONNECTOR_LIMITS.maxToolResultChars)).text,
  };
}

export function validateRedirectUri(value) {
  try {
    if (typeof value !== "string" || value.length > 2048) return null;
    const url = new URL(String(value));
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export const __test__ = { sanitizeValue, PAIRING_ALPHABET };
