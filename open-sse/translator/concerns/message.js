import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array when every part is plain text. Several
// OpenAI-compatible endpoints reject text-only arrays even though they accept
// multimodal arrays. Cache-aware targets retain marked blocks and boundaries.
export function collapseTextParts(parts, opts = {}) {
  const collapsible = parts.length > 0
    && parts.every((part) => part.type === OPENAI_BLOCK.TEXT)
    && !(opts.preserveCacheControl && parts.some((part) => part.cache_control));
  return collapsible ? parts.map((part) => part.text || "").join("\n") : parts;
}
