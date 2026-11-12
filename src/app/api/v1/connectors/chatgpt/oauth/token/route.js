import { handleTokenRequest, oauthErrorResponse, oauthJson } from "@/lib/chatgptConnector/oauth.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try { return oauthJson(await handleTokenRequest(request)); }
  catch (error) { return oauthErrorResponse(error); }
}
