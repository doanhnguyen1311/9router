import { admitApiKeyRequest } from "@/lib/db/repos/apiKeysRepo.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { extractClientApiKey } from "@/shared/utils/requestApiKey.js";
import * as log from "../utils/logger.js";

const LABELS = {
  requests: "request",
  input_tokens: "input token",
  cost: "cost",
};

function displayValue(kind, value) {
  if (kind === "cost") return `$${Number(value).toFixed(6)}`;
  return Math.floor(Number(value) || 0).toLocaleString("en-US");
}

export function quotaExceededMessage(exceeded, admission = {}) {
  const label = LABELS[exceeded.kind] || exceeded.kind;
  const prefix = `API key ${label} limit reached (${displayValue(exceeded.kind, exceeded.used)} / ${displayValue(exceeded.kind, exceeded.limit)}).`;
  if (admission.quota?.resetMode === "scheduled" && admission.usage?.nextResetAt) {
    return `${prefix} Usage resets automatically at ${admission.usage.nextResetAt}, or an admin can reset it sooner in Dashboard > Endpoint.`;
  }
  return `${prefix} An admin must reset usage or raise the limit in Dashboard > Endpoint.`;
}

/**
 * Check current-window quota counters and atomically consume one request slot.
 * Call only after request validation/access checks and before credential lookup.
 * Unknown/no-key requests remain unchanged; authentication is handled elsewhere.
 */
export async function enforceApiKeyQuota(request) {
  const apiKey = extractClientApiKey(request);
  if (!apiKey) return null;

  const admission = await admitApiKeyRequest(apiKey);
  if (admission.allowed) return null;

  const exceeded = admission.exceeded;
  log.warn("AUTH", `API key quota exceeded: ${exceeded.kind} ${exceeded.used}/${exceeded.limit}`);
  const resetAt = admission.quota?.resetMode === "scheduled" ? admission.usage?.nextResetAt : null;
  const retryAfter = resetAt
    ? Math.max(1, Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000))
    : null;
  return errorResponse(
    HTTP_STATUS.RATE_LIMITED,
    quotaExceededMessage(exceeded, admission),
    {
      "x-9router-quota-kind": exceeded.kind,
      "x-9router-quota-used": String(exceeded.used),
      "x-9router-quota-limit": String(exceeded.limit),
      ...(resetAt ? { "x-9router-quota-reset-at": resetAt } : {}),
      ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
    },
  );
}
