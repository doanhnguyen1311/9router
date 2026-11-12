import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { issueExecutionTicket, readExecutionForPlan } from "@/lib/execution/service.js";
import { planningErrorResponse, readPlanningJson } from "../../_response.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, planId } = await params;
    const execution = await readExecutionForPlan(id, planId, identity);
    return projectJson({ executions: execution ? [execution] : [] });
  } catch (error) { return planningErrorResponse(error); }
}

export async function POST(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, planId } = await params;
    return projectJson({ ticket: await issueExecutionTicket(id, planId, await readPlanningJson(request), identity) }, 201);
  } catch (error) { return planningErrorResponse(error); }
}
