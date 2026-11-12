import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { planningErrorResponse, readPlanningJson } from "@/app/api/v1/projects/[id]/plans/_response.js";
import { createConnector, listConnectors } from "@/lib/chatgptConnector/repository.js";
import { protectedResourceMetadata } from "@/lib/chatgptConnector/oauth.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    return projectJson({ connectors: await listConnectors(id, identity) });
  } catch (error) { return planningErrorResponse(error); }
}

export async function POST(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    const result = await createConnector(id, await readPlanningJson(request), identity);
    return projectJson({ ...result, mcpUrl: protectedResourceMetadata(request).resource }, 201);
  } catch (error) { return planningErrorResponse(error); }
}
