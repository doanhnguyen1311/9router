import { KEY_EFFORT_VALUES } from "@/shared/utils/keyEffort.js";
import { NextResponse } from "next/server";
import { getApiKeyUsageSummary } from "@/lib/usageDb.js";
import { getApiKeyByKey, updateApiKey } from "@/lib/localDb.js";
import { extractClientApiKey } from "@/shared/utils/requestApiKey.js";
import { findAllowedModel } from "@/shared/utils/keyModelRouting.js";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function visibilityFromKeyRecord(keyRecord) {
  return {
    allowKeyUsage: keyRecord?.allowKeyUsage !== false,
    canViewModelList: keyRecord?.allowKeyUsageModelList !== false,
  };
}

function usageDisabledResponse() {
  return NextResponse.json(
    { error: "Key Usage is disabled for this API key." },
    { status: 403, headers: NO_STORE_HEADERS },
  );
}

function visibleSummary(summary, canViewModelList) {
  const response = {
    ...summary,
    permissions: { canViewModelList },
  };
  if (!canViewModelList) {
    delete response.modelAccess;
    delete response.models;
    if (response.effortPolicy) {
      response.effortPolicy = { ...response.effortPolicy };
      delete response.effortPolicy.overrides;
    }
  }
  return response;
}

function updatedPreferences(updated, canViewModelList) {
  const effortPolicy = { ...updated.effortPolicy };
  if (!canViewModelList) delete effortPolicy.overrides;
  const response = {
    effortPolicy,
    permissions: { canViewModelList },
  };
  if (canViewModelList) {
    response.modelAccess = {
      restricted: updated.access.restricted === true,
      allowedModels: [...updated.access.allow],
      publicModel: updated.modelRouting.alias,
      selectedModel: updated.modelRouting.selectedModel,
    };
  }
  return response;
}

export async function GET(request) {
  try {
    const apiKey = extractClientApiKey(request);
    const keyRecord = await getApiKeyByKey(apiKey);

    // Keep missing, unknown and disabled keys indistinguishable so this public
    // endpoint cannot be used to enumerate issued keys or their state.
    if (!keyRecord?.isActive || keyRecord.isExpired) {
      return NextResponse.json(
        { error: "API key is invalid or inactive." },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }
    const visibility = visibilityFromKeyRecord(keyRecord);
    if (!visibility.allowKeyUsage) return usageDisabledResponse();
    const summary = await getApiKeyUsageSummary(apiKey, keyRecord);
    if (!summary) {
      return NextResponse.json(
        { error: "API key is invalid or inactive." },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }

    return NextResponse.json(
      visibleSummary(summary, visibility.canViewModelList),
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[API] Failed to get API key usage:", error);
    return NextResponse.json(
      { error: "Unable to load usage right now." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

export async function PATCH(request) {
  try {
    const apiKey = extractClientApiKey(request);
    const keyRecord = await getApiKeyByKey(apiKey);
    if (!keyRecord?.isActive || keyRecord.isExpired) {
      return NextResponse.json(
        { error: "API key is invalid or inactive." },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }
    const visibility = visibilityFromKeyRecord(keyRecord);
    if (!visibility.allowKeyUsage) return usageDisabledResponse();
    const body = await request.json().catch(() => null);
    if (!body || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(k => !["selectedModel", "selectedEffort"].includes(k))) {
      return NextResponse.json({ error: "Only selectedModel and selectedEffort may be changed" }, { status: 400, headers: NO_STORE_HEADERS });
    }
    const updates = {};
    if (body.selectedModel !== undefined) {
      if (!visibility.canViewModelList) {
        return NextResponse.json(
          { error: "Model viewing and selection are disabled for this API key." },
          { status: 403, headers: NO_STORE_HEADERS },
        );
      }
      if (!keyRecord.modelRouting?.alias || typeof body.selectedModel !== "string") return NextResponse.json({ error: "Public model name required to select a target" }, { status: 400, headers: NO_STORE_HEADERS });
      const selectedModel = findAllowedModel(keyRecord.access.allow, body.selectedModel);
      if (!selectedModel) return NextResponse.json({ error: "Selected model is not allowed for this API key" }, { status: 403, headers: NO_STORE_HEADERS });
      updates.modelRouting = { alias: keyRecord.modelRouting.alias, selectedModel };
    }
    if (Object.hasOwn(body, "selectedEffort")) {
      if (!keyRecord.effortPolicy?.allowUserChoice) return NextResponse.json({ error: "Effort is controlled by the administrator" }, { status: 403, headers: NO_STORE_HEADERS });
      if (body.selectedEffort !== null && !KEY_EFFORT_VALUES.includes(body.selectedEffort)) return NextResponse.json({ error: "Invalid effort level" }, { status: 400, headers: NO_STORE_HEADERS });
      updates.selectedEffort = body.selectedEffort;
    }
    // The repository rechecks Key Usage and effort access inside the write transaction.
    const updated = await updateApiKey(
      keyRecord.id,
      updates,
      { keyUsageSelfService: true },
    );
    return NextResponse.json(
      updatedPreferences(updated, visibility.canViewModelList),
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[API] Failed to update API key model selection:", error);
    if (error?.code === "KEY_EFFORT_FORBIDDEN") return NextResponse.json({ error: "Effort is controlled by the administrator" }, { status: 403, headers: NO_STORE_HEADERS });
    if (error?.code === "KEY_USAGE_FORBIDDEN") return usageDisabledResponse();
    if (error?.code === "KEY_USAGE_MODEL_LIST_FORBIDDEN") {
      return NextResponse.json(
        { error: "Model viewing and selection are disabled for this API key." },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
    if (error?.code === "INVALID_KEY_EFFORT") return NextResponse.json({ error: "Invalid effort level" }, { status: 400, headers: NO_STORE_HEADERS });
    if (error?.code === "INVALID_KEY_MODEL_ROUTING") {
      return NextResponse.json(
        { error: "The allowed model configuration changed. Reload and try again." },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { error: "Unable to update the selected model right now." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
