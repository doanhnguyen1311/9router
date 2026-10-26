import { EventEmitter } from "events";

// Process-local change notifications for the dashboard. The SSE endpoint sends
// only an invalidation signal; clients reload /api/keys through the normal
// authenticated route, so API key material is never placed in an event payload.
if (!global._apiKeyEvents) {
  global._apiKeyEvents = new EventEmitter();
  global._apiKeyEvents.setMaxListeners(50);
}

export const apiKeyEvents = global._apiKeyEvents;

export function notifyApiKeysChanged() {
  apiKeyEvents.emit("change");
}
