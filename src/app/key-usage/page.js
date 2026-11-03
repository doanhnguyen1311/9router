import { notFound } from "next/navigation";
import { getSettings } from "@/lib/localDb.js";
import KeyUsageClient from "./KeyUsageClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "API Key Usage | 9Router",
  description: "View the current usage window for an active 9Router API key.",
};

export default async function KeyUsagePage() {
  const settings = await getSettings();
  if (settings.allowKeyUsage === false) notFound();
  return <KeyUsageClient />;
}
