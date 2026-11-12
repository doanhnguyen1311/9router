import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { getPlanOptions } from "@/lib/planning/service.js";
import { planningErrorResponse } from "../../_response.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, planId } = await params;
    const revisionValue = new URL(request.url).searchParams.get("revision");
    const revision = revisionValue == null ? null : Number(revisionValue);
    if (revisionValue != null && (!Number.isSafeInteger(revision) || revision < 1)) {
      const error = new Error("revision must be a positive integer");
      error.code = "PLANNING_INPUT_INVALID";
      error.status = 400;
      throw error;
    }
    return projectJson({ options: await getPlanOptions(id, planId, identity, revision) });
  } catch (error) {
    return planningErrorResponse(error);
  }
}
