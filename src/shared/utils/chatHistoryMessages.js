// Presentation only: saved payloads are already bounded/redacted by History.
// Keep protocol envelopes in the raw view, and render conversation content here.
const roleName = role => role === 'model' ? 'assistant' : role === 'function' ? 'tool' : role;
const text = value => typeof value === 'string' ? value : '';

export function formatHistoryValue(value) {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2) ?? '';
}

function parts(value, depth = 0) {
  if (value == null || value === '') return [];
  if (typeof value === 'string') return [{ kind: 'text', text: value }];
  if (depth > 8) return [{ kind: 'json', value }];
  if (Array.isArray(value)) return value.flatMap(item => parts(item, depth + 1));
  if (typeof value !== 'object') return [{ kind: 'text', text: String(value) }];
  const type = value.type || '';
  if (['tool_use', 'function_call'].includes(type) || value.functionCall) {
    const call = value.functionCall || value;
    return [{ kind: 'tool_call', name: call.name || 'Tool call', id: call.call_id || call.id, value: call.arguments ?? call.args ?? call.input }];
  }
  if (['tool_result', 'function_call_output'].includes(type) || value.functionResponse) {
    const result = value.functionResponse || value;
    return [{ kind: 'tool_result', name: result.name || 'Tool result', id: result.tool_use_id || result.call_id, value: result.output ?? result.response ?? result.content }];
  }
  if (['thinking', 'reasoning', 'summary_text', 'reasoning_text'].includes(type)) {
    return [{ kind: 'reasoning', text: text(value.thinking) || text(value.text) || (Array.isArray(value.summary) ? value.summary.map(item => item.text || '').join('\n') : text(value.summary)) }];
  }
  if (typeof value.text === 'string') return [{ kind: 'text', text: value.text }];
  if (typeof value.refusal === 'string') return [{ kind: 'text', text: value.refusal }];
  if (/image|audio|video|document|file/.test(type) || value.inlineData || value.inline_data || value.fileData) {
    return [{ kind: 'attachment', text: `${type || 'Media'}${value.mime_type ? ` · ${value.mime_type}` : ''} · binary content omitted` }];
  }
  if (value.parts) return parts(value.parts, depth + 1);
  if (value.content !== undefined) return parts(value.content, depth + 1);
  return [{ kind: 'json', value }];
}

function message(item, fallback = 'user') {
  if (item == null) return null;
  let role = roleName(item.role) || (['tool_result', 'function_call_output'].includes(item.type) ? 'tool' : item.type === 'function_call' ? 'assistant' : fallback);
  const content = typeof item === 'string' ? parts(item) : ['function_call', 'function_call_output', 'tool_use', 'tool_result', 'reasoning'].includes(item.type)
    ? parts(item) : parts(item.content ?? item.parts);
  if (item.reasoning_content || typeof item.reasoning === 'string') content.unshift({ kind: 'reasoning', text: item.reasoning_content || item.reasoning });
  for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : []) {
    const fn = call.function || call;
    content.push({ kind: 'tool_call', name: fn.name || 'Tool call', id: call.id || call.call_id, value: fn.arguments ?? fn.input });
  }
  if (item.function_call) content.push({ kind: 'tool_call', name: item.function_call.name, value: item.function_call.arguments });
  if (role === 'user' && content.length && content.every(part => part.kind === 'tool_result')) role = 'tool';
  return content.length ? { role, name: item.name, id: item.tool_call_id || item.call_id, parts: content } : null;
}

export function historyMessages(detail) {
  const request = [], source = detail.request || {};
  for (const key of ['system', 'instructions', 'systemInstruction']) if (source[key]) {
    const entry = message({ role: 'system', content: source[key]?.parts || source[key] });
    if (entry) request.push(entry);
  }
  for (const key of ['messages', 'input', 'contents']) if (source[key] !== undefined) {
    const items = Array.isArray(source[key]) ? source[key] : [source[key]];
    for (const item of items) { const entry = message(item); if (entry) request.push(entry); }
  }
  const raw = Array.isArray(detail.response) ? detail.response : detail.response ? [detail.response] : [];
  // The worker's assembled messages are authoritative. Native events often
  // repeat the same text at content-part/item/response completion boundaries.
  const direct = raw.filter(item => item?.role || ['message', 'function_call', 'function_call_output', 'tool_result'].includes(item?.type)).map(item => message(item, 'assistant')).filter(Boolean);
  if (direct.length) return { request, response: direct };
  const output = [];
  for (const item of raw) {
    if (Array.isArray(item?.output)) output.push(...item.output);
    else if (item?.type === 'response.output_item.done' && item.item) output.push(item.item);
    else if (item?.type === 'response.completed' && Array.isArray(item.response?.output)) {
      // Prefer the final snapshot when no assembled message was captured.
      output.splice(0, output.length, ...item.response.output);
    } else if (Array.isArray(item?.candidates)) output.push(...item.candidates.map(candidate => candidate.content).filter(Boolean));
    else if (Array.isArray(item?.choices)) output.push(...item.choices.map(choice => choice.message).filter(Boolean));
    else if (item?.content !== undefined && !item.type?.startsWith('response.')) output.push(item);
  }
  const seen = new Set();
  const response = [];
  for (const item of output) {
    if (item.id && seen.has(item.id)) continue;
    if (item.id) seen.add(item.id);
    const entry = message(item, 'assistant'); if (entry) response.push(entry);
  }
  return { request, response };
}
