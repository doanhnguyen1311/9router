import { requireIdentity, projectJson } from "@/app/api/projects/_response.js";
import { planningErrorResponse } from "@/app/api/v1/projects/[id]/plans/_response.js";
import { getConnector, listConnectorAudit, revokeConnector } from "@/lib/chatgptConnector/repository.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, connectorId } = await params;
    const connector = await getConnector(id, connectorId, identity);
    const auditLog = await listConnectorAudit(id, connectorId, identity, new URL(request.url).searchParams.get("auditLimit"));
    return projectJson({ connector, auditLog });
  } catch (error) { return planningErrorResponse(error); }
}

export async function DELETE(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id, connectorId } = await params;
    return projectJson({ connector: await revokeConnector(id, connectorId, identity) });
  } catch (error) { return planningErrorResponse(error); }
}
