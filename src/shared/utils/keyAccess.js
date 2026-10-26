// Per-API-key access control: pure helpers (no DB, no
// request objects), shared by the DB repo, the API routes and the engine.
import {
  KEY_ACCESS_MAX_ENTRIES,
  KEY_ACCESS_MAX_ENTRY_LENGTH,
  KEY_ACCESS_UNRESTRICTED,
} from "@/shared/constants/keyAccess.js";

/**
 * Normalize an allow list: keep strings only, trim, drop empties, de-duplicate
 * case-insensitively (the first spelling wins). Order is preserved.
 */
export function normalizeAllowList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const entry = item.trim();
    if (!entry) continue;
    const k = entry.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(entry);
  }
  return out;
}

// Connection ids are opaque, case-sensitive identifiers. Keep their exact
// spelling while trimming and de-duplicating them.
export function normalizeAccountIds(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function filterConnectionsByAllowedIds(connections, allowedConnectionIds) {
  if (!Array.isArray(connections) || allowedConnectionIds === undefined) return connections;
  const allowed = new Set(normalizeAccountIds(allowedConnectionIds));
  return connections.filter((connection) => allowed.has(connection?.id));
}

/**
 * Build the access object from the model and account access columns.
 *
 * Fails CLOSED: the restricted flag has its own INTEGER column, so a corrupt or
 * unparsable allow list can only ever shrink what a restricted key may call
 * (to nothing); it can never turn a restricted key into an unrestricted one.
 */
export function keyAccessFromColumns(restrictedCol, allowCol, accountRestrictedCol, accountIdsCol) {
  const restricted = restrictedCol === 1 || restrictedCol === true;
  let parsed = [];
  if (restricted && typeof allowCol === "string" && allowCol) {
    try { parsed = JSON.parse(allowCol); } catch { parsed = []; }
  }
  const accountRestricted = accountRestrictedCol === 1 || accountRestrictedCol === true;
  let parsedAccountIds = [];
  if (accountRestricted && typeof accountIdsCol === "string" && accountIdsCol) {
    try { parsedAccountIds = JSON.parse(accountIdsCol); } catch { parsedAccountIds = []; }
  }
  return {
    restricted,
    allow: restricted ? normalizeAllowList(parsed) : [],
    accountRestricted,
    accountIds: accountRestricted ? normalizeAccountIds(parsedAccountIds) : [],
  };
}

/** Columns to persist for an access object (already validated/normalized). */
export function keyAccessToColumns(access) {
  const value = access || KEY_ACCESS_UNRESTRICTED;
  return {
    accessRestricted: value.restricted ? 1 : 0,
    accessAllow: JSON.stringify(value.restricted ? normalizeAllowList(value.allow) : []),
    accessAccountRestricted: value.accountRestricted ? 1 : 0,
    accessAccountIds: JSON.stringify(value.accountRestricted ? normalizeAccountIds(value.accountIds) : []),
  };
}

/**
 * Validate client input for an access update
 * ({ restricted, allow, accountRestricted, accountIds }).
 * Rejects rather than repairs: wrong types, too many entries, overlong entries.
 * @returns {{ ok: true, value: {restricted: boolean, allow: string[], accountRestricted: boolean, accountIds: string[]} } | { ok: false, error: string }}
 */
export function validateKeyAccessInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "access must be an object" };
  }
  const extra = Object.keys(input).filter((k) => !["restricted", "allow", "accountRestricted", "accountIds"].includes(k));
  if (extra.length) return { ok: false, error: `access: unexpected field(s) ${extra.join(", ")}` };
  if (typeof input.restricted !== "boolean") {
    return { ok: false, error: "access.restricted must be a boolean" };
  }
  const allow = input.allow === undefined ? [] : input.allow;
  if (!Array.isArray(allow) || allow.some((e) => typeof e !== "string")) {
    return { ok: false, error: "access.allow must be an array of strings" };
  }
  if (allow.length > KEY_ACCESS_MAX_ENTRIES) {
    return { ok: false, error: `access.allow has more than ${KEY_ACCESS_MAX_ENTRIES} entries` };
  }
  if (allow.some((e) => e.trim().length > KEY_ACCESS_MAX_ENTRY_LENGTH)) {
    return { ok: false, error: `access.allow entries must be at most ${KEY_ACCESS_MAX_ENTRY_LENGTH} characters` };
  }
  const accountRestricted = input.accountRestricted === undefined ? false : input.accountRestricted;
  if (typeof accountRestricted !== "boolean") {
    return { ok: false, error: "access.accountRestricted must be a boolean" };
  }
  const accountIds = input.accountIds === undefined ? [] : input.accountIds;
  if (!Array.isArray(accountIds) || accountIds.some((e) => typeof e !== "string")) {
    return { ok: false, error: "access.accountIds must be an array of strings" };
  }
  if (accountIds.length > KEY_ACCESS_MAX_ENTRIES) {
    return { ok: false, error: `access.accountIds has more than ${KEY_ACCESS_MAX_ENTRIES} entries` };
  }
  if (accountIds.some((e) => e.trim().length > KEY_ACCESS_MAX_ENTRY_LENGTH)) {
    return { ok: false, error: `access.accountIds entries must be at most ${KEY_ACCESS_MAX_ENTRY_LENGTH} characters` };
  }
  return {
    ok: true,
    value: {
      restricted: input.restricted,
      allow: input.restricted ? normalizeAllowList(allow) : [],
      accountRestricted,
      accountIds: accountRestricted ? normalizeAccountIds(accountIds) : [],
    },
  };
}
