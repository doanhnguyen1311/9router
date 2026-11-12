import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { planningErrorResponse } from "@/app/api/v1/projects/[id]/plans/_response.js";
import { rotatePairingCode } from "@/lib/chatgptConnector/repository.js";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, connectorId } = await params;
    return projectJson(await rotatePairingCode(id, connectorId, identity));
  } catch (error) { return planningErrorResponse(error); }
}
