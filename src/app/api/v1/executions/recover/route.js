import { verifyWorkerRequest } from "@/lib/execution/auth.js";
import { recoverExecutionLeases } from "@/lib/execution/service.js";
import { planningErrorResponse } from "@/app/api/v1/projects/[id]/plans/_response.js";
import { NextResponse } from "next/server";

export async function POST(request) {
  try {
    verifyWorkerRequest(request);
    return NextResponse.json({ recovered: await recoverExecutionLeases() }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return planningErrorResponse(error); }
}
