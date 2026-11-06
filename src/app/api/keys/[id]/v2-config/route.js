import { hasAdminSession } from "@/lib/auth/adminSession.js";
import {
  getV2ProxyAdminConfigById,
  updateV2ProxyAdminConfigById,
} from "@/lib/localDb";

export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

function json(body, status = 200) {
  return Response.json(body, { status, headers: PRIVATE_HEADERS });
}

// This is the only client-facing read path that may return the decrypted V2
// destination and credential. It requires a real dashboard admin session even
// when general dashboard login is disabled.
export async function GET(request, { params }) {
  if (!(await hasAdminSession(request))) {
    return json({ error: "Admin session required" }, 401);
  }

  try {
    const { id } = await params;
    const config = await getV2ProxyAdminConfigById(id);
    if (!config) return json({ error: "Key not found" }, 404);
    return json({ v2Proxy: config });
  } catch {
    return json({ error: "Failed to load V2 configuration" }, 500);
  }
}

export async function PUT(request, { params }) {
  if (!(await hasAdminSession(request))) {
    return json({ error: "Admin session required" }, 401);
  }

  try {
    const { id } = await params;
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)
      || !Object.prototype.hasOwnProperty.call(body, "v2Proxy")) {
      return json({ error: "Invalid request" }, 400);
    }
    const input = body.v2Proxy;
    if (!input || typeof input !== "object" || Array.isArray(input)
      || typeof input.enabled !== "boolean") {
      return json({ error: "Invalid request" }, 400);
    }
    const config = await updateV2ProxyAdminConfigById(id, input);
    if (!config) return json({ error: "Key not found" }, 404);
    return json({ v2Proxy: config });
  } catch (error) {
    if (error?.code === "INVALID_V2_PROXY_CONFIG" || error instanceof SyntaxError) {
      return json({ error: error?.code === "INVALID_V2_PROXY_CONFIG" ? error.message : "Invalid request" }, 400);
    }
    return json({ error: "Failed to update V2 configuration" }, 500);
  }
}
