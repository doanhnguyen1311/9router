import { NextResponse } from "next/server";
import { getProjectIdentity } from "@/lib/projectMemory/identity.js";
import { consumeProjectApiBudget } from "@/lib/projectMemory/rateLimit.js";
import { isSameOriginMutation } from "@/lib/auth/sameOrigin.js";

export const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

export async function requireIdentity(request) {
  if (!isSameOriginMutation(request)) {
    const error = new Error("Cross-origin project mutation rejected");
    error.status = 403;
    error.code = "CROSS_ORIGIN_MUTATION";
    throw error;
  }
  const identity = await getProjectIdentity(request);
  if (!identity) {
    const error = new Error("Authentication required");
    error.status = 401;
    error.code = "UNAUTHORIZED";
    throw error;
  }
  const budget = consumeProjectApiBudget(identity.principalId, request);
  if (!budget.allowed) {
    const error = new Error("Project API rate limit exceeded");
    error.status = 429;
    error.code = "PROJECT_RATE_LIMIT";
    error.retryAfter = budget.retryAfter;
    throw error;
  }
  return identity;
}

export function projectJson(data, status = 200) {
  return NextResponse.json(data, { status, headers: NO_STORE });
}

export function projectErrorResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) console.error("[Project Memory]", error);
  const headers = { ...NO_STORE };
  if (status === 429) headers["Retry-After"] = String(error.retryAfter || 60);
  return NextResponse.json(
    { error: status >= 500 ? "Project Memory operation failed" : error.message, code: error?.code || "PROJECT_ERROR" },
    { status, headers },
  );
}
