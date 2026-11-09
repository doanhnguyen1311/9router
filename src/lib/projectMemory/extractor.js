import crypto from "node:crypto";
import { MEMORY_TYPES } from "./config.js";

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;
const SPACE = /\s+/g;

function clean(value, max = 1000) {
  return String(value || "").replace(SPACE, " ").trim().slice(0, max);
}

function candidate(type, subject, value, confidence, sourceType, evidenceReference, extra = {}) {
  const normalizedType = MEMORY_TYPES.includes(type) ? type : "technical_fact";
  const normalizedSubject = clean(subject, 240);
  const normalizedValue = clean(value, 1600);
  if (!normalizedSubject || !normalizedValue || normalizedValue.length < 3) return null;
  return {
    memoryType: normalizedType,
    subject: normalizedSubject,
    value: normalizedValue,
    confidence: Math.max(0, Math.min(1, confidence)),
    sourceType,
    evidenceReference,
    structuredContent: { subject: normalizedSubject, value: normalizedValue, ...extra },
  };
}

function subjectFromSentence(sentence, fallback) {
  const colon = sentence.indexOf(":");
  if (colon > 1 && colon < 100) return clean(sentence.slice(0, colon), 120);
  const words = clean(sentence).split(" ").slice(0, 8).join(" ");
  return words || fallback;
}

export function extractMemoryCandidates(payload, { sourceType = "inferred", evidenceReference = null } = {}) {
  const text = clean(payload?.text || payload?.userText || payload?.toolText || "", 32_000);
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const sentences = text.split(SENTENCE_SPLIT).map((item) => clean(item, 1800)).filter((item) => item.length >= 8).slice(0, 120);

  for (const sentence of sentences) {
    let item = null;
    let match;
    if ((match = sentence.match(/(?:decid(?:e|ed)|quyết định|chọn)\s+(?:to\s+|use\s+|sử dụng\s+)?(.{3,})/i))) {
      const replacement = match[1].match(/(.+?)\s+(?:instead of|thay (?:cho|vì))\s+(.+)/i);
      item = candidate("decision", subjectFromSentence(sentence, "Project decision"), match[1], 0.92, sourceType, evidenceReference,
        replacement ? { previousValue: clean(replacement[2]), status: "active" } : { status: "active" });
    } else if (/\b(?:must|must not|required|never|constraint|bắt buộc|không được|phải)\b/i.test(sentence)) {
      item = candidate("constraint", subjectFromSentence(sentence, "Project constraint"), sentence, sourceType === "user-confirmed" ? 0.9 : 0.7, sourceType, evidenceReference);
    } else if (/\b(?:architecture|service|module|database|gateway|pipeline|kiến trúc|cơ sở dữ liệu)\b/i.test(sentence)
      && /\b(?:uses?|contains?|depends?|connects?|implemented|sử dụng|phụ thuộc|gồm)\b/i.test(sentence)) {
      item = candidate("architecture", subjectFromSentence(sentence, "Architecture"), sentence, sourceType === "tool-verified" ? 0.94 : 0.76, sourceType, evidenceReference);
    } else if (/\b(?:todo|task|implement|add|fix|cần làm|triển khai|sửa)\b/i.test(sentence)) {
      // Assistant statements remain suggestions and are never marked completed.
      item = candidate("task", subjectFromSentence(sentence, "Project task"), sentence, sourceType === "user-confirmed" ? 0.82 : 0.55, sourceType, evidenceReference, { status: "open" });
    } else if (/\b(?:error|bug|issue|fails?|broken|lỗi|vấn đề)\b/i.test(sentence)) {
      item = candidate("issue", subjectFromSentence(sentence, "Project issue"), sentence, sourceType === "tool-verified" ? 0.95 : 0.7, sourceType, evidenceReference);
    } else if (/\b(?:resolved|solution|fixed by|giải pháp|đã sửa bằng)\b/i.test(sentence)) {
      item = candidate("resolution", subjectFromSentence(sentence, "Resolution"), sentence, sourceType === "tool-verified" ? 0.94 : 0.65, sourceType, evidenceReference);
    } else if (sourceType === "tool-verified" && /(?:created|updated|wrote|read|deleted|modified)\s+[^\s]+\.[a-z0-9]+/i.test(sentence)) {
      item = candidate("file", subjectFromSentence(sentence, "File evidence"), sentence, 0.9, sourceType, evidenceReference);
    }
    if (!item) continue;
    const fingerprint = crypto.createHash("sha256").update(`${item.memoryType}|${item.subject.toLowerCase()}|${item.value.toLowerCase()}`).digest("hex");
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push({ ...item, fingerprint });
  }
  return out.slice(0, 50);
}

export const __test__ = { clean, subjectFromSentence };
