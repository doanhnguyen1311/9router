import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { planningProviderHealth } from "@/lib/planning/service.js";
import { planningErrorResponse, readPlanningJson } from "@/app/api/v1/projects/[id]/plans/_response.js";

export async function POST(request) {
  try {
    await requireIdentity(request);
    const health = await planningProviderHealth(await readPlanningJson(request));
    return projectJson({ health }, health.ok ? 200 : 503);
  } catch (error) {
    return planningErrorResponse(error);
  }
}
