import { searchGraph } from "@/lib/projectMemory/graphRepository.js";
import { projectErrorResponse, projectJson, requireIdentity } from "../../_response.js";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    return projectJson({ graph: await searchGraph(id, identity.principalId, query) });
  } catch (error) { return projectErrorResponse(error); }
}
