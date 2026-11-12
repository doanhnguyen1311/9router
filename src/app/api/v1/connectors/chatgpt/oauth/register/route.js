import { handleClientRegistration, oauthErrorResponse, oauthJson } from "@/lib/chatgptConnector/oauth.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try { return oauthJson(await handleClientRegistration(request), 201); }
  catch (error) { return oauthErrorResponse(error); }
}
