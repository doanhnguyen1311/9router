import { oauthJson, protectedResourceMetadata } from "@/lib/chatgptConnector/oauth.js";

export const dynamic = "force-dynamic";

export function GET(request) {
  return oauthJson(protectedResourceMetadata(request));
}
