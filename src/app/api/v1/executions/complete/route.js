import { verifyWorkerRequest } from "@/lib/execution/auth.js";
import { completeExecutionTicket } from "@/lib/execution/service.js";
import { planningErrorResponse, readPlanningJson } from "@/app/api/v1/projects/[id]/plans/_response.js";
import { NextResponse } from "next/server";

export async function POST(request) {
  try {
    const { workerId } = verifyWorkerRequest(request);
    const body = await readPlanningJson(request);
    return NextResponse.json({ execution: await completeExecutionTicket(body.ticket, workerId, body.result) }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return planningErrorResponse(error); }
}
