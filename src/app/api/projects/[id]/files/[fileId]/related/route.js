import { getRelatedFiles } from "@/lib/projectMemory/fileIntelligence.js";
import { projectErrorResponse, projectJson, requireIdentity } from "../../../../_response.js";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, fileId } = await params;
    return projectJson({ related: await getRelatedFiles(id, fileId, identity.principalId, new URL(request.url).searchParams.get("depth")) });
  } catch (error) { return projectErrorResponse(error); }
}
