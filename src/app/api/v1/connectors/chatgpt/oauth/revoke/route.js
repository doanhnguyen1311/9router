import { handleRevocationRequest, oauthErrorResponse } from "@/lib/chatgptConnector/oauth.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    await handleRevocationRequest(request);
    return new Response(null, { status: 200, headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return oauthErrorResponse(error); }
}
