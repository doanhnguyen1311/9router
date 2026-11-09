import { listProjectMembers, removeProjectMember, transferProjectOwnership, upsertProjectMember } from "@/lib/projectMemory/repository.js";
import { projectErrorResponse, projectJson, requireIdentity } from "../../_response.js";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    return projectJson({ members: await listProjectMembers(id, identity.principalId) });
  } catch (error) { return projectErrorResponse(error); }
}

export async function POST(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    const body = await request.json();
    if (body.action === "transfer") {
      return projectJson({ project: await transferProjectOwnership(id, body.principalId, identity) });
    }
    return projectJson({ members: await upsertProjectMember(id, body, identity) });
  } catch (error) { return projectErrorResponse(error); }
}

export async function DELETE(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    const body = await request.json();
    return projectJson({ members: await removeProjectMember(id, body.principalId, identity) });
  } catch (error) { return projectErrorResponse(error); }
}
