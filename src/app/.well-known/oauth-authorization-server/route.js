import { authorizationServerMetadata, oauthJson } from "@/lib/chatgptConnector/oauth.js";

export const dynamic = "force-dynamic";

export function GET(request) {
  return oauthJson(authorizationServerMetadata(request));
}
