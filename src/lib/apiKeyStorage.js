import crypto from "node:crypto";
import { loadJwtSecret } from "@/lib/auth/persistentSecret.js";

const VERSION = "ak1";
const IV_BYTES = 12;

function applicationSecret() {
  return loadJwtSecret();
}

function encryptionKey(machineId) {
  return crypto.createHash("sha256")
    .update("9router:api-key-storage\0")
    .update(applicationSecret())
    .update("\0")
    .update(String(machineId || ""))
    .digest();
}

export function hashApiKey(value) {
  if (typeof value !== "string" || !value) return null;
  return crypto.createHmac("sha256", applicationSecret()).update(value).digest("hex");
}

export function encryptStoredApiKey(value, machineId) {
  if (typeof value !== "string" || !value) return null;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(machineId), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptStoredApiKey(value, machineId) {
  try {
    const [version, ivRaw, tagRaw, ciphertextRaw, extra] = String(value || "").split(".");
    if (version !== VERSION || !ivRaw || !tagRaw || !ciphertextRaw || extra !== undefined) return null;
    const iv = Buffer.from(ivRaw, "base64url");
    const tag = Buffer.from(tagRaw, "base64url");
    const ciphertext = Buffer.from(ciphertextRaw, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16 || !ciphertext.length) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(machineId), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8") || null;
  } catch { return null; }
}

export function protectApiKey(value, machineId) {
  const keyHash = hashApiKey(value);
  if (!keyHash) throw new Error("Invalid API key");
  return {
    storageKey: `h1:${keyHash}`,
    keyHash,
    keyEncrypted: encryptStoredApiKey(value, machineId),
  };
}

export function revealApiKey(row) {
  if (!row) return null;
  const decrypted = decryptStoredApiKey(row.keyEncrypted, row.machineId);
  if (decrypted) return decrypted;
  // Backward-compatible read for a row created by an older release. Migration
  // replaces these values, but this also keeps interrupted upgrades usable.
  return typeof row.key === "string" && !row.key.startsWith("h1:") ? row.key : null;
}

export function isProtectedApiKeyRow(row) {
  return typeof row?.key === "string" && row.key.startsWith("h1:")
    && typeof row?.keyHash === "string" && row.keyHash.length === 64
    && typeof row?.keyEncrypted === "string" && row.keyEncrypted.startsWith(`${VERSION}.`);
}
