import { KEY_ACCESS_MAX_ENTRY_LENGTH } from "@/shared/constants/keyAccess.js";

export const KEY_MODEL_ROUTING_DISABLED = Object.freeze({
  alias: null,
  selectedModel: null,
});

const clean = (value) => (typeof value === "string" ? value.trim() : "");
const lower = (value) => clean(value).toLowerCase();

export function keyModelRoutingFromColumns(aliasCol, selectedModelCol) {
  const alias = clean(aliasCol) || null;
  const selectedModel = alias ? (clean(selectedModelCol) || null) : null;
  return { alias, selectedModel };
}

export function keyModelRoutingToColumns(routing) {
  const alias = clean(routing?.alias) || null;
  return {
    modelAlias: alias,
    selectedModel: alias ? (clean(routing?.selectedModel) || null) : null,
  };
}

export function findAllowedModel(allow, requested) {
  const wanted = lower(requested);
  if (!wanted || !Array.isArray(allow)) return null;
  return allow.find((entry) => lower(entry) === wanted) || null;
}

/**
 * Validate the admin-owned public alias and its current target. A configured
 * alias is useful only on a restricted key with at least one allowed target.
 * A missing target is initialized to the first allowed entry so the alias is
 * never left pointing nowhere.
 */
export function validateKeyModelRoutingInput(input, access) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "modelRouting must be an object" };
  }
  const extra = Object.keys(input).filter((key) => !["alias", "selectedModel"].includes(key));
  if (extra.length) {
    return { ok: false, error: `modelRouting: unexpected field(s) ${extra.join(", ")}` };
  }
  if (input.alias !== null && input.alias !== undefined && typeof input.alias !== "string") {
    return { ok: false, error: "modelRouting.alias must be a string or null" };
  }
  if (input.selectedModel !== null && input.selectedModel !== undefined && typeof input.selectedModel !== "string") {
    return { ok: false, error: "modelRouting.selectedModel must be a string or null" };
  }

  const alias = clean(input.alias);
  if (!alias) return { ok: true, value: { ...KEY_MODEL_ROUTING_DISABLED } };
  if (alias.length > KEY_ACCESS_MAX_ENTRY_LENGTH) {
    return { ok: false, error: `modelRouting.alias must be at most ${KEY_ACCESS_MAX_ENTRY_LENGTH} characters` };
  }
  if (!access?.restricted || !Array.isArray(access.allow) || access.allow.length === 0) {
    return { ok: false, error: "Configure at least one allowed model before setting a public model name" };
  }
  if (findAllowedModel(access.allow, alias)) {
    return { ok: false, error: "Public model name must not match an allowed model name" };
  }

  const requestedTarget = clean(input.selectedModel);
  const selectedModel = requestedTarget
    ? findAllowedModel(access.allow, requestedTarget)
    : access.allow[0];
  if (!selectedModel) {
    return { ok: false, error: "Selected model must be in this API key's allowed model list" };
  }

  return { ok: true, value: { alias, selectedModel } };
}

/** Keep admin routing valid after its allowlist changes. */
export function reconcileKeyModelRouting(routing, access) {
  const alias = clean(routing?.alias);
  if (!alias || !access?.restricted || !Array.isArray(access.allow) || access.allow.length === 0) {
    return { ...KEY_MODEL_ROUTING_DISABLED };
  }
  if (findAllowedModel(access.allow, alias)) return { ...KEY_MODEL_ROUTING_DISABLED };
  return {
    alias,
    selectedModel: findAllowedModel(access.allow, routing?.selectedModel) || access.allow[0],
  };
}

/** Resolve only the per-key public alias. Direct allowed model names pass through. */
export function resolveKeyModelRequest(ctx, requested) {
  if (typeof requested !== "string") return requested;
  const alias = ctx?.modelRouting?.alias;
  const selectedModel = ctx?.modelRouting?.selectedModel;
  if (alias && selectedModel && lower(alias) === lower(requested)) return selectedModel;
  return requested;
}
