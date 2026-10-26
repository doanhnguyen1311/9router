import { apiKeyEvents } from "@/lib/apiKeyEvents.js";

export const dynamic = "force-dynamic";

const CHANGE_EVENT = "event: keys-changed\ndata: {\"type\":\"keys-changed\"}\n\n";

// GET /api/keys/stream - Notify dashboard clients when key configuration or
// usage counters change. Deliberately carries no key/configuration payload.
export async function GET() {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, send: null };

  const close = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.send) apiKeyEvents.off("change", state.send);
    if (state.keepalive) clearInterval(state.keepalive);
  };

  const stream = new ReadableStream({
    start(controller) {
      state.send = () => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(CHANGE_EVENT));
        } catch {
          close();
        }
      };

      // Immediate invalidation gives a newly opened/reconnected page a fresh
      // snapshot without putting sensitive data into the SSE frame.
      state.send();
      apiKeyEvents.on("change", state.send);
      state.keepalive = setInterval(() => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          close();
        }
      }, 25000);
      state.keepalive.unref?.();
    },
    cancel: close,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
