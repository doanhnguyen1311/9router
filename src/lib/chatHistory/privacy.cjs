// Shared by the collector and the unbundled worker. Never traverse unbounded input.
const limits = require('./limits.cjs');
const SECRET_FIELD = /authorization|cookie|api.?key|access.?token|refresh.?token|password|secret|credential|signature/i;
function redact(text) {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\bBearer\s+[\w.+/~=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|sess-|ghp_|gho_|github_pat_|xox[baprs]-|AKIA)[\w-]{8,}/g, '[REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED JWT]')
    .replace(/((?:authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]')
    .replace(/data:[\w/+.-]+;base64,[\w+/=\s]+/g, '[OMITTED BINARY]')
    .replace(/https?:\/\/[^\s"<>]+/g, '[URL OMITTED]')
    .replace(/\b[A-Za-z0-9+/=_-]{160,}\b/g, '[OMITTED OPAQUE DATA]')
    .replace(/\0/g, '');
}
function sanitize(value, maxBytes = 65536, secrets = []) {
  let left = maxBytes, nodes = 0, truncated = false;
  function walk(v, depth = 0, key = '') {
    if (++nodes > 3000 || depth > 16 || left < 32) { truncated = true; return '[TRUNCATED]'; }
    left -= 16;
    if (SECRET_FIELD.test(key)) return '[REDACTED]';
    if (/^(data|b64_json|bytes|audio|inlineData|inline_data|image_url|file_data)$/i.test(key)) return '[BINARY OMITTED]';
    if (typeof v === 'string') {
      // Slice BEFORE regex/UTF8 work. Allow for JSON escaping (six bytes/character).
      const cap = Math.max(0, Math.floor(left / 6));
      if (v.length > cap) truncated = true;
      // Own the bounded text: a V8 sliced string can retain a huge original body.
      let safe = redact(Buffer.from(v.slice(0, cap), 'utf8').toString('utf8'));
      for (const secret of secrets) if (secret && secret.length >= 4) safe = safe.split(secret).join("[REDACTED]");
      left -= safe.length * 6;
      return safe;
    }
    if (v == null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v !== 'object') return null;
    if (Array.isArray(v)) {
      const out = [];
      for (let i = 0; i < v.length; i++) {
        if (left < 32 || nodes > 3000) { truncated = true; break; }
        out.push(walk(v[i], depth + 1, key));
      }
      return out;
    }
    const out = {};
    // Keep the speaker even when content appears first and consumes its budget.
    const hasRole = Object.prototype.hasOwnProperty.call(v, 'role') && typeof v.role === 'string';
    if (hasRole) { left -= 27; out.role = walk(v.role, depth + 1, 'role'); }
    // for..in avoids allocating Object.entries on huge objects.
    for (const k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (k === 'role' && hasRole) continue;
      if (left < 32 || nodes > 3000) { truncated = true; break; }
      if (k === '__proto__' || k === 'constructor' || k.length > 100) continue;
      const keyBudget = k.length * 6 + 3;
      if (left < keyBudget + 32) { truncated = true; break; }
      left -= keyBudget;
      out[k] = walk(v[k], depth + 1, k);
    }
    return out;
  }
  const cleaned = walk(value);
  return { value: cleaned, truncated, usedBytes: Math.max(0, maxBytes - left) };
}

// Reserve room for recent user input before long system prompts or old context.
// Copy only bounded sanitized values; never clone the original conversation.
function sanitizeRequest(fields, maxBytes, secrets = []) {
  const value = {};
  const main = ['messages', 'input', 'contents'].filter(key => fields[key] !== undefined);
  const extra = ['system', 'instructions', 'systemInstruction', 'tools'].filter(key => fields[key] !== undefined);
  let remaining = Math.max(0, maxBytes - 128 * (main.length + extra.length + 1)), truncated = false;
  function capture(raw, budget) {
    if (!Array.isArray(raw)) return sanitize(raw, budget, secrets);
    const head = raw.length > limits.requestMessages && ['system', 'developer'].includes(raw[0]?.role);
    const start = Math.max(0, raw.length - (limits.requestMessages - (head ? 1 : 0)));
    const indices = head ? [0] : [];
    for (let i = start; i < raw.length; i++) if (!head || i !== 0) indices.push(i);
    const priority = indices.findLast(index => raw[index]?.role === 'user') ?? indices.at(-1);
    const order = priority === undefined ? [] : [priority, ...indices.toReversed().filter(index => index !== priority)];
    const messages = [];
    let left = Math.max(0, budget - 32), cut = indices.length < raw.length;
    for (let i = 0; i < order.length; i++) {
      if (left < 128) { cut = true; break; }
      const share = Math.floor(left / (order.length - i));
      const allowance = i === 0 ? Math.max(share, Math.floor(left / 3)) : share;
      const result = sanitize(raw[order[i]], allowance, secrets);
      left -= result.usedBytes + 16; cut ||= result.truncated;
      messages.push({ index: order[i], value: result.value });
    }
    messages.sort((a, b) => a.index - b.index);
    return { value: messages.map(item => item.value), truncated: cut, usedBytes: budget - Math.max(0, left) };
  }
  for (let i = 0; i < main.length; i++) {
    const budget = Math.max(64, Math.floor(remaining * (extra.length ? 0.75 : 1) / (main.length - i)));
    const result = capture(fields[main[i]], budget);
    value[main[i]] = result.value; remaining -= result.usedBytes; truncated ||= result.truncated;
  }
  for (let i = 0; i < extra.length; i++) {
    const result = sanitize(fields[extra[i]], Math.max(64, Math.floor(remaining / (extra.length - i))), secrets);
    value[extra[i]] = result.value; remaining -= result.usedBytes; truncated ||= result.truncated;
  }
  return { value, truncated };
}
module.exports = { sanitize, sanitizeRequest, redact };
