import { handleMcpPost, handleMcpUnsupportedMethod } from "@/lib/chatgptConnector/mcp.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() { return handleMcpUnsupportedMethod(); }
export function DELETE() { return handleMcpUnsupportedMethod(); }
export function POST(request) { return handleMcpPost(request); }
