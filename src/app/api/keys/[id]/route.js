import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";
import { validateKeyQuotaInput } from "@/shared/utils/keyQuota.js";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, access, quota } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (access !== undefined) {
      const checked = validateKeyAccessInput(access);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      updateData.access = checked.value;
    }
    if (quota !== undefined) {
      // Legacy clients only know the three numeric limits. Preserve the reset
      // policy unless the request explicitly changes it.
      const quotaInput = { ...quota };
      if (quotaInput.resetMode === undefined) {
        quotaInput.resetMode = existing.quota.resetMode;
        quotaInput.resetInterval = existing.quota.resetInterval;
        quotaInput.resetIntervalValue = existing.quota.resetIntervalValue;
        quotaInput.resetIntervalUnit = existing.quota.resetIntervalUnit;
      } else if (quotaInput.resetMode === "manual" && quotaInput.resetInterval === undefined) {
        quotaInput.resetInterval = null;
        quotaInput.resetIntervalValue = null;
        quotaInput.resetIntervalUnit = null;
      }
      // Older clients do not know about key expiration. Updating numeric
      // limits must not silently turn an expiring key into a permanent one.
      if (quotaInput.expiresAt === undefined) {
        quotaInput.expiresAt = existing.quota.expiresAt ?? null;
      }
      const checked = validateKeyQuotaInput(quotaInput);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      updateData.quota = checked.value;
    }

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
