import {
  getPlanningSessionForApiKey,
  planningOperationErrorResponse,
  planningSessionResponse,
} from "@/lib/planning/orchestration.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { planId } = await params;
    const { plan, keyRecord } = await getPlanningSessionForApiKey(request, planId);
    return planningSessionResponse(plan, keyRecord, 200);
  } catch (error) {
    return planningOperationErrorResponse(error);
  }
}
