import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { requestCancellation } from "@/lib/execution/service.js";
import { planningErrorResponse, readPlanningJson } from "@/app/api/v1/projects/[id]/plans/_response.js";

export async function POST(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, executionId } = await params;
    return projectJson({ execution: await requestCancellation(id, executionId, await readPlanningJson(request), identity) });
  } catch (error) {
    return planningErrorResponse(error);
  }
}
