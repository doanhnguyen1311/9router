import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { createPlan, listPlans } from "@/lib/planning/service.js";
import { planningErrorResponse, readPlanningJson } from "./_response.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    const url = new URL(request.url);
    const plans = await listPlans(id, identity, {
      status: url.searchParams.get("status"),
      limit: url.searchParams.get("limit"),
    });
    return projectJson({ plans });
  } catch (error) {
    return planningErrorResponse(error);
  }
}

export async function POST(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    const plan = await createPlan(id, await readPlanningJson(request), identity, { signal: request.signal });
    return projectJson({ plan }, 201);
  } catch (error) {
    return planningErrorResponse(error);
  }
}
