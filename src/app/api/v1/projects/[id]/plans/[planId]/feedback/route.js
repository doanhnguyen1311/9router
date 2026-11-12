import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { submitFeedback } from "@/lib/planning/service.js";
import { planningErrorResponse, readPlanningJson } from "../../_response.js";

export async function POST(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, planId } = await params;
    const plan = await submitFeedback(id, planId, await readPlanningJson(request), identity);
    return projectJson({ plan });
  } catch (error) {
    return planningErrorResponse(error);
  }
}
