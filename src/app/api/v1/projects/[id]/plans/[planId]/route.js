import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { getPlan } from "@/lib/planning/service.js";
import { planningErrorResponse } from "../_response.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, planId } = await params;
    return projectJson({ plan: await getPlan(id, planId, identity) });
  } catch (error) {
    return planningErrorResponse(error);
  }
}
