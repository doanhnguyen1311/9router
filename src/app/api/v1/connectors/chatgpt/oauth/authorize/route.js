import { beginAuthorization, completeAuthorization, oauthErrorResponse } from "@/lib/chatgptConnector/oauth.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try { return await beginAuthorization(request); }
  catch (error) { return oauthErrorResponse(error); }
}

export async function POST(request) {
  try { return await completeAuthorization(request); }
  catch (error) { return oauthErrorResponse(error); }
}
