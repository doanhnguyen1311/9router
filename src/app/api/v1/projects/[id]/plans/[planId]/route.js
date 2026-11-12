import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { getPlan } from "@/lib/planning/service.js";
import { readExecutionForPlan } from "@/lib/execution/service.js";
import { planningErrorResponse } from "../_response.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, planId } = await params;
    const plan = await getPlan(id, planId, identity);
    plan.execution = await readExecutionForPlan(id, planId, identity);
    return projectJson({ plan });
  } catch (error) {
    return planningErrorResponse(error);
  }
}
