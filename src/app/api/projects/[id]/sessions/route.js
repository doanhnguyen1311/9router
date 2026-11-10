import { deleteProjectSessions, listProjectSessions } from "@/lib/projectMemory/repository.js";
import { projectErrorResponse, projectJson, requireIdentity } from "../../_response.js";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    return projectJson({ sessions: await listProjectSessions(id, identity.principalId, new URL(request.url).searchParams.get("limit")) });
  } catch (error) { return projectErrorResponse(error); }
}

export async function DELETE(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    return projectJson({ deleted: await deleteProjectSessions(id, identity) });
  } catch (error) { return projectErrorResponse(error); }
}
