import { verifyWorkerRequest } from "@/lib/execution/auth.js";
import { claimExecutionTicket } from "@/lib/execution/service.js";
import { validateWorkspace } from "@/lib/execution/workspace.js";
import { planningErrorResponse, readPlanningJson } from "@/app/api/v1/projects/[id]/plans/_response.js";
import { NextResponse } from "next/server";

export async function POST(request) {
  try {
    const { workerId } = verifyWorkerRequest(request);
    const body = await readPlanningJson(request);
    const claimed = await claimExecutionTicket(body.ticket, workerId, { validateWorkspace: (workspace) => validateWorkspace(workspace) });
    return NextResponse.json(claimed, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return planningErrorResponse(error); }
}
