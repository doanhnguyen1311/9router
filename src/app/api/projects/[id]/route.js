import { deleteProject, getProjectById, updateProject } from "@/lib/projectMemory/repository.js";
import { projectErrorResponse, projectJson, requireIdentity } from "../_response.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    const project = await getProjectById(id, identity.principalId);
    if (!project) return projectJson({ error: "Project not found" }, 404);
    return projectJson({ project });
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function PATCH(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    const project = await updateProject(id, await request.json(), identity);
    return projectJson({ project });
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function DELETE(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    await deleteProject(id, identity, body.confirmation);
    return projectJson({ deleted: true });
  } catch (error) {
    return projectErrorResponse(error);
  }
}
