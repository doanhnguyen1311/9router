import { NextResponse } from "next/server";
import { getApiKeys, createApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { validateKeyQuotaInput } from "@/shared/utils/keyQuota.js";
import { validateV2ProxyInput } from "@/lib/v2ProxyConfig.js";
import { getProjectIdentity } from "@/lib/projectMemory/identity.js";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = await getApiKeys();
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, quota, v2Proxy } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    let checkedQuota;
    if (quota !== undefined) {
      checkedQuota = validateKeyQuotaInput(quota);
      if (!checkedQuota.ok) {
        return NextResponse.json({ error: checkedQuota.error }, { status: 400 });
      }
    }

    const checkedV2Proxy = validateV2ProxyInput(v2Proxy);
    if (!checkedV2Proxy.ok) {
      return NextResponse.json({ error: checkedV2Proxy.error }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const identity = await getProjectIdentity(request);
    const apiKey = await createApiKey(name, machineId, checkedQuota?.value, checkedV2Proxy.value, identity?.principalId);

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      allowKeyUsage: apiKey.allowKeyUsage,
      allowKeyUsageModelList: apiKey.allowKeyUsageModelList,
      projectAccess: apiKey.projectAccess,
      v2Proxy: apiKey.v2Proxy,
      quota: apiKey.quota,
      usage: apiKey.usage,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
