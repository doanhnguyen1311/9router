import { assignApiKeyToProject, listAssignableApiKeysForProject, listProjectApiKeys, requireProjectRole } from "@/lib/projectMemory/repository.js";
import { projectErrorResponse, projectJson, requireIdentity } from "../../_response.js";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    const [apiKeys, availableApiKeys] = await Promise.all([
      listProjectApiKeys(id, identity.principalId),
      listAssignableApiKeysForProject(id, identity.principalId, identity.admin),
    ]);
    return projectJson({ apiKeys, availableApiKeys });
  } catch (error) { return projectErrorResponse(error); }
}

export async function POST(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    await requireProjectRole(id, identity.principalId, ["owner", "editor"]);
    const body = await request.json();
    const assignment = await assignApiKeyToProject(body.apiKeyId, id, identity);
    return projectJson({ assignment });
  } catch (error) { return projectErrorResponse(error); }
}

export async function DELETE(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    await requireProjectRole(id, identity.principalId, ["owner", "editor"]);
    const body = await request.json();
    await assignApiKeyToProject(body.apiKeyId, null, identity, { removeFromProjectId: id });
    return projectJson({ assignment: null });
  } catch (error) { return projectErrorResponse(error); }
}
