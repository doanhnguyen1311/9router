import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { approvePlan } from "@/lib/planning/service.js";
import { planningErrorResponse, readPlanningJson } from "../../_response.js";

export async function POST(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, planId } = await params;
    return projectJson({ plan: await approvePlan(id, planId, await readPlanningJson(request), identity) });
  } catch (error) {
    return planningErrorResponse(error);
  }
}
