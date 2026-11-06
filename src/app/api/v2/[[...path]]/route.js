import { handleV2ProxyRequest } from "@/lib/v2Proxy.js";

export const dynamic = "force-dynamic";

async function proxy(request, { params }) {
  const resolved = await params;
  return handleV2ProxyRequest(request, resolved?.path || []);
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
