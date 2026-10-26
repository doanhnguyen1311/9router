import KeyUsageClient from "./KeyUsageClient";

export const metadata = {
  title: "API Key Usage | 9Router",
  description: "View the current usage window for an active 9Router API key.",
};

export default function KeyUsagePage() {
  return <KeyUsageClient />;
}
