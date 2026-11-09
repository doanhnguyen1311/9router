const MAX_EVENT_TEXT = 32_000;

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    return item?.text || item?.input_text || item?.output_text || item?.content || "";
  }).filter((item) => typeof item === "string").join("\n");
}

function pushMessage(out, role, content, source = null) {
  const text = textFromContent(content).replace(/\u0000/g, "").trim();
  if (!text) return;
  out.push({ role: String(role || "unknown").slice(0, 40), text: text.slice(0, MAX_EVENT_TEXT), source });
}

export function normalizeRequestContent(body) {
  const messages = [];
  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      const source = message?.role === "tool" || message?.type === "tool_result" ? "tool" : null;
      pushMessage(messages, message?.role, message?.content, source);
    }
  }
  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (typeof item === "string") pushMessage(messages, "user", item);
      else if (item?.type === "function_call_output") pushMessage(messages, "tool", item.output, "tool");
      else pushMessage(messages, item?.role || item?.type, item?.content || item?.text);
    }
  } else if (typeof body?.input === "string") {
    pushMessage(messages, "user", body.input);
  }
  if (Array.isArray(body?.contents)) {
    for (const item of body.contents) pushMessage(messages, item?.role || "user", item?.parts);
  }
  if (body?.request?.contents) {
    for (const item of body.request.contents) pushMessage(messages, item?.role || "user", item?.parts);
  }
  const userText = messages.filter((item) => item.role === "user").map((item) => item.text).join("\n").slice(0, MAX_EVENT_TEXT);
  const toolText = messages.filter((item) => item.source === "tool" || item.role === "tool").map((item) => item.text).join("\n").slice(0, MAX_EVENT_TEXT);
  return { messages, userText, toolText };
}

export function normalizeResponseContent(value) {
  if (!value) return "";
  const body = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  if (!body) return String(value).slice(0, MAX_EVENT_TEXT);
  const candidates = [
    body?.choices?.[0]?.message?.content,
    body?.choices?.[0]?.text,
    body?.content,
    body?.output_text,
    body?.response?.candidates?.[0]?.content?.parts,
  ];
  if (Array.isArray(body?.output)) {
    for (const item of body.output) candidates.push(item?.content);
  }
  return candidates.map(textFromContent).filter(Boolean).join("\n").slice(0, MAX_EVENT_TEXT);
}

export function latestQueryText(body) {
  const normalized = normalizeRequestContent(body);
  return normalized.userText.split("\n").filter(Boolean).slice(-3).join("\n").slice(0, 4000);
}
