import { deleteMemory, getMemoryHistory, updateMemory } from "@/lib/projectMemory/memoryRepository.js";
import { projectErrorResponse, projectJson, requireIdentity } from "../../../_response.js";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, memoryId } = await params;
    return projectJson({ history: await getMemoryHistory(id, memoryId, identity.principalId) });
  } catch (error) { return projectErrorResponse(error); }
}

export async function PATCH(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, memoryId } = await params;
    return projectJson({ memory: await updateMemory(id, memoryId, await request.json(), identity) });
  } catch (error) { return projectErrorResponse(error); }
}

export async function DELETE(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, memoryId } = await params;
    return projectJson({ deleted: await deleteMemory(id, memoryId, identity) });
  } catch (error) { return projectErrorResponse(error); }
}
