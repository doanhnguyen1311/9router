import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { getPlanRevisions, revisePlan } from "@/lib/planning/service.js";
import { planningErrorResponse, readPlanningJson } from "../../_response.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, planId } = await params;
    return projectJson({ revisions: await getPlanRevisions(id, planId, identity) });
  } catch (error) {
    return planningErrorResponse(error);
  }
}

export async function POST(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, planId } = await params;
    const plan = await revisePlan(id, planId, await readPlanningJson(request), identity, { signal: request.signal });
    return projectJson({ plan });
  } catch (error) {
    return planningErrorResponse(error);
  }
}
