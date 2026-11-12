import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { readExecution } from "@/lib/execution/service.js";
import { planningErrorResponse } from "@/app/api/v1/projects/[id]/plans/_response.js";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, executionId } = await params;
    return projectJson({ execution: await readExecution(id, executionId, identity) });
  } catch (error) { return planningErrorResponse(error); }
}
