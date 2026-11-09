import {
  cancelProjectFileIndexing,
  getProjectFile,
  reindexProjectFile,
  removeProjectFile,
} from "@/lib/projectMemory/fileIntelligence.js";
import { projectErrorResponse, projectJson, requireIdentity } from "../../../_response.js";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, fileId } = await params;
    return projectJson({ file: await getProjectFile(id, fileId, identity.principalId) });
  } catch (error) { return projectErrorResponse(error); }
}

export async function POST(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, fileId } = await params;
    const body = await request.json();
    if (body.action === "reindex") return projectJson({ file: await reindexProjectFile(id, fileId, identity) });
    if (body.action === "cancel") return projectJson({ cancelled: await cancelProjectFileIndexing(id, fileId, identity) });
    return projectJson({ error: "Unknown file action" }, 400);
  } catch (error) { return projectErrorResponse(error); }
}

export async function DELETE(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, fileId } = await params;
    return projectJson({ deleted: await removeProjectFile(id, fileId, identity) });
  } catch (error) { return projectErrorResponse(error); }
}
