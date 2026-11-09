import { getProjectAnalytics } from "@/lib/projectMemory/analytics.js";
import { projectErrorResponse, projectJson, requireIdentity } from "../../_response.js";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    return projectJson({ analytics: await getProjectAnalytics(id, identity.principalId) });
  } catch (error) { return projectErrorResponse(error); }
}
