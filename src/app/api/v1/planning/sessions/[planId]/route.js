import {
  getPlanningSessionForApiKey,
  planningCorsOptionsResponse,
  planningOperationErrorResponse,
  planningSessionResponse,
} from "@/lib/planning/orchestration.js";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return planningCorsOptionsResponse();
}

export async function GET(request, { params }) {
  try {
    const { planId } = await params;
    const { plan, keyRecord } = await getPlanningSessionForApiKey(request, planId);
    return planningSessionResponse(plan, keyRecord, 200);
  } catch (error) {
    return planningOperationErrorResponse(error);
  }
}
