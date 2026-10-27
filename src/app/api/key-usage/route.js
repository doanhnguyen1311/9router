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

export async function GET(request) {
  try {
    const apiKey = extractClientApiKey(request);
    const summary = await getApiKeyUsageSummary(apiKey);

    // Keep missing, unknown and disabled keys indistinguishable so this public
    // endpoint cannot be used to enumerate issued keys or their state.
    if (!summary) {
      return NextResponse.json(
        { error: "API key is invalid or inactive." },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }

    return NextResponse.json(summary, { headers: NO_STORE_HEADERS });
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
    if (!keyRecord.modelRouting?.alias) {
      return NextResponse.json(
        { error: "This API key does not have a public model name configured." },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || Object.keys(body).some((key) => key !== "selectedModel") || typeof body.selectedModel !== "string") {
      return NextResponse.json(
        { error: "selectedModel must be a string." },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    const selectedModel = findAllowedModel(keyRecord.access.allow, body.selectedModel);
    if (!selectedModel) {
      return NextResponse.json(
        { error: "Selected model is not allowed for this API key." },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }

    const updated = await updateApiKey(keyRecord.id, {
      modelRouting: {
        alias: keyRecord.modelRouting.alias,
        selectedModel,
      },
    });
    return NextResponse.json({
      modelAccess: {
        restricted: updated.access.restricted === true,
        allowedModels: [...updated.access.allow],
        publicModel: updated.modelRouting.alias,
        selectedModel: updated.modelRouting.selectedModel,
      },
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to update API key model selection:", error);
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
