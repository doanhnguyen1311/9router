import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";

let cachedJwtSecret = null;

// Shared persistent server secret. Keeping generation here prevents separate
// security features from racing to create different values for the same file.
export function loadJwtSecret() {
  if (cachedJwtSecret) return cachedJwtSecret;
  if (process.env.JWT_SECRET) {
    cachedJwtSecret = process.env.JWT_SECRET;
    return cachedJwtSecret;
  }
  const file = path.join(DATA_DIR, "jwt-secret");
  try {
    cachedJwtSecret = fs.readFileSync(file, "utf8").trim();
    if (cachedJwtSecret) return cachedJwtSecret;
  } catch { /* create below */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  cachedJwtSecret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, cachedJwtSecret, { mode: 0o600 });
  return cachedJwtSecret;
}
