import { NextResponse } from "next/server";
import {
  deleteApiKey,
  getApiKeyById,
  getApiKeys,
  getCombos,
  getCustomModels,
  getModelAliases,
  getProviderConnections,
  updateApiKey,
} from "@/lib/localDb";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";
import { validateKeyModelRoutingInput } from "@/shared/utils/keyModelRouting.js";
import { validateKeyQuotaInput } from "@/shared/utils/keyQuota.js";
import { AI_MODELS } from "@/shared/constants/models.js";
import { getProviderAlias } from "@/shared/constants/providers.js";

const lower = (value) => String(value || "").trim().toLowerCase();

async function findPublicModelNameCollision(alias, currentKeyId) {
  const wanted = lower(alias);
  if (!wanted) return null;
  const reserved = new Map();
  const add = (value, label) => {
    const normalized = lower(value);
    if (normalized && !reserved.has(normalized)) reserved.set(normalized, label);
  };

  for (const model of AI_MODELS) {
    add(model.model, "an existing model");
    add(`${model.provider}/${model.model}`, "an existing model");
  }

  const [keys, combos, aliases, customModels, connections] = await Promise.all([
    getApiKeys(),
    getCombos(),
    getModelAliases(),
    getCustomModels(),
    getProviderConnections(),
  ]);
  for (const key of keys) {
    if (key.id !== currentKeyId) add(key.modelRouting?.alias, "another API key's public model name");
    for (const allowed of key.access?.allow || []) add(allowed, "an allowed model name");
  }
  for (const combo of combos) add(combo.name, "an existing combo");
  for (const [name, target] of Object.entries(aliases || {})) {
    add(name, "an existing model alias");
    if (typeof target === "string") add(target, "an existing model or alias");
  }
  for (const model of customModels) {
    add(model?.id, "an existing custom model");
    if (model?.providerAlias && model?.id) add(`${model.providerAlias}/${model.id}`, "an existing custom model");
  }
  for (const connection of connections) {
    const providerAlias = connection?.providerSpecificData?.prefix
      || getProviderAlias(connection?.provider)
      || connection?.provider;
    for (const model of connection?.providerSpecificData?.enabledModels || []) {
      add(model, "an enabled provider model");
      if (providerAlias && !String(model).includes("/")) add(`${providerAlias}/${model}`, "an enabled provider model");
    }
  }

  return reserved.get(wanted) || null;
}

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, access, quota, modelRouting } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (access !== undefined) {
      const checked = validateKeyAccessInput(access);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      updateData.access = checked.value;
    }
    if (quota !== undefined) {
      // Legacy clients only know the three numeric limits. Preserve the reset
      // policy unless the request explicitly changes it.
      const quotaInput = { ...quota };
      if (quotaInput.resetMode === undefined) {
        quotaInput.resetMode = existing.quota.resetMode;
        quotaInput.resetInterval = existing.quota.resetInterval;
        quotaInput.resetIntervalValue = existing.quota.resetIntervalValue;
        quotaInput.resetIntervalUnit = existing.quota.resetIntervalUnit;
      } else if (quotaInput.resetMode === "manual" && quotaInput.resetInterval === undefined) {
        quotaInput.resetInterval = null;
        quotaInput.resetIntervalValue = null;
        quotaInput.resetIntervalUnit = null;
      }
      // Older clients do not know about key expiration. Updating numeric
      // limits must not silently turn an expiring key into a permanent one.
      if (quotaInput.expiresAt === undefined) {
        quotaInput.expiresAt = existing.quota.expiresAt ?? null;
      }
      const checked = validateKeyQuotaInput(quotaInput);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      updateData.quota = checked.value;
    }
    if (modelRouting !== undefined) {
      const effectiveAccess = updateData.access || existing.access;
      const checked = validateKeyModelRoutingInput(modelRouting, effectiveAccess);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      if (checked.value.alias) {
        const collision = await findPublicModelNameCollision(checked.value.alias, id);
        if (collision) {
          return NextResponse.json(
            { error: `Public model name conflicts with ${collision}` },
            { status: 409 },
          );
        }
      }
      updateData.modelRouting = checked.value;
    }

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    if (error?.code === "KEY_MODEL_ALIAS_CONFLICT") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error?.code === "INVALID_KEY_MODEL_ROUTING") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
