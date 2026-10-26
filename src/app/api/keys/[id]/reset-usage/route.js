import { NextResponse } from "next/server";
import { resetApiKeyUsage } from "@/lib/localDb";

// POST /api/keys/[id]/reset-usage - Reset all current-window usage counters for one key.
export async function POST(_request, { params }) {
  try {
    const { id } = await params;
    const key = await resetApiKeyUsage(id);
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error resetting key usage:", error);
    return NextResponse.json({ error: "Failed to reset key usage" }, { status: 500 });
  }
}
