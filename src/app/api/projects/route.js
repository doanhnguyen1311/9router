import { createProject, listProjects } from "@/lib/projectMemory/repository.js";
import { projectErrorResponse, projectJson, requireIdentity } from "./_response.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const identity = await requireIdentity(request);
    const url = new URL(request.url);
    const projects = await listProjects(identity.principalId, {
      includeAll: identity.admin && url.searchParams.get("scope") === "all",
      search: url.searchParams.get("q") || "",
    });
    return projectJson({ projects });
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function POST(request) {
  try {
    const identity = await requireIdentity(request);
    const body = await request.json();
    const project = await createProject(body, identity);
    return projectJson({ project }, 201);
  } catch (error) {
    return projectErrorResponse(error);
  }
}
