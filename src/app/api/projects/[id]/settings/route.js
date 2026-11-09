import { getProjectSettings, updateProjectSettings } from "@/lib/projectMemory/repository.js";
import { projectErrorResponse, projectJson, requireIdentity } from "../../_response.js";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    return projectJson({ settings: await getProjectSettings(id, identity.principalId) });
  } catch (error) { return projectErrorResponse(error); }
}

export async function PATCH(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    return projectJson({ settings: await updateProjectSettings(id, await request.json(), identity) });
  } catch (error) { return projectErrorResponse(error); }
}
