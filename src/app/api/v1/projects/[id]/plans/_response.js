import { NextResponse } from "next/server";
import { NO_STORE } from "@/app/api/projects/_response.js";

const MAX_PLANNING_BODY_BYTES = 128 * 1024;

export async function readPlanningJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_PLANNING_BODY_BYTES) {
    const error = new Error("Planning request body is too large");
    error.code = "PLANNING_BODY_TOO_LARGE";
    error.status = 413;
    throw error;
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_PLANNING_BODY_BYTES) {
    const error = new Error("Planning request body is too large");
    error.code = "PLANNING_BODY_TOO_LARGE";
    error.status = 413;
    throw error;
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch {
    const error = new Error("Invalid JSON body");
    error.code = "PLANNING_INVALID_JSON";
    error.status = 400;
    throw error;
  }
}

export function planningErrorResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) console.error("[Planning]", error);
  return NextResponse.json({
    error: status >= 500 ? "Planning operation failed" : error.message,
    code: error?.code || "PLANNING_ERROR",
    ...(status < 500 && error?.details ? { details: error.details } : {}),
  }, { status, headers: NO_STORE });
}
