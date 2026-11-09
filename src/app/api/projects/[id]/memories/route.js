import { createManualMemory, listMemories } from "@/lib/projectMemory/memoryRepository.js";
import { projectErrorResponse, projectJson, requireIdentity } from "../../_response.js";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    return projectJson({ memories: await listMemories(id, identity.principalId, query) });
  } catch (error) { return projectErrorResponse(error); }
}

export async function POST(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    return projectJson({ memory: await createManualMemory(id, await request.json(), identity) }, 201);
  } catch (error) { return projectErrorResponse(error); }
}
