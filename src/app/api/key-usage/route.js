import { NextResponse } from "next/server";
import { getApiKeyUsageSummary } from "@/lib/usageDb.js";
import { extractClientApiKey } from "@/shared/utils/requestApiKey.js";

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
