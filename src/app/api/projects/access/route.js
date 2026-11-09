import { getApiKeyById, updateApiKey } from "@/lib/localDb.js";
import {
  getEffectiveUserProjectAccess,
  getProjectSystemSettings,
  setUserProjectAccess,
  updateProjectSystemSettings,
} from "@/lib/projectMemory/repository.js";
import { projectErrorResponse, projectJson, requireIdentity } from "../_response.js";

export async function GET(request) {
  try {
    const identity = await requireIdentity(request);
    return projectJson({
      system: await getProjectSystemSettings(),
      user: await getEffectiveUserProjectAccess(identity.principalId),
      principalId: identity.principalId,
      admin: identity.admin,
    });
  } catch (error) { return projectErrorResponse(error); }
}

export async function PATCH(request) {
  try {
    const identity = await requireIdentity(request);
    if (!identity.admin) return projectJson({ error: "Admin access required" }, 403);
    const body = await request.json();
    if (body.scope === "global") {
      return projectJson({ system: await updateProjectSystemSettings(body.settings || {}, identity.principalId) });
    }
    if (body.scope === "user") {
      return projectJson({ permission: await setUserProjectAccess(body.principalId, body.enabled, identity.principalId) });
    }
    if (body.scope === "apiKey") {
      const key = await getApiKeyById(body.apiKeyId);
      if (!key) return projectJson({ error: "API key not found" }, 404);
      const updated = await updateApiKey(key.id, { projectAccess: body.enabled });
      return projectJson({ apiKey: { id: updated.id, projectAccess: updated.projectAccess } });
    }
    return projectJson({ error: "Invalid permission scope" }, 400);
  } catch (error) { return projectErrorResponse(error); }
}
