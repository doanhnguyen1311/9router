import { afterEach, describe, expect, it } from "vitest";

import { apiKeyEvents, notifyApiKeysChanged } from "@/lib/apiKeyEvents.js";
import { GET } from "@/app/api/keys/stream/route.js";

const decoder = new TextDecoder();
const readers = [];

afterEach(async () => {
  while (readers.length) {
    await readers.pop().cancel().catch(() => {});
  }
});

describe("GET /api/keys/stream", () => {
  it("streams secret-free invalidations for initial sync and later changes", async () => {
    const listenersBefore = apiKeyEvents.listenerCount("change");
    const response = await GET();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");

    const reader = response.body.getReader();
    readers.push(reader);
    const initial = decoder.decode((await reader.read()).value);
    expect(initial).toContain("event: keys-changed");
    expect(initial).toContain('{"type":"keys-changed"}');
    expect(initial).not.toMatch(/sk-|apiKey|accountIds|quota/i);
    expect(apiKeyEvents.listenerCount("change")).toBe(listenersBefore + 1);

    const nextFrame = reader.read();
    notifyApiKeysChanged();
    const changed = decoder.decode((await nextFrame).value);
    expect(changed).toContain("event: keys-changed");

    await reader.cancel();
    readers.pop();
    expect(apiKeyEvents.listenerCount("change")).toBe(listenersBefore);
  });
});
