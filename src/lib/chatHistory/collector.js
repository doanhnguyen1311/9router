import { randomUUID } from 'node:crypto';
import privacy from './privacy.cjs';
import { HISTORY_LIMITS } from './config.js';

// One observer per logical request; never a tee (a tee can buffer an idle client).
export function createCollector({ body, endpoint, config, enqueue, release = () => {}, secret = null, userAgent = '' }) {
  const limit = config.chatHistoryMaxContentBytes;
  const tailLimit = HISTORY_LIMITS.streamTailBytes;
  // Reserve metadata + request budget, then allow worst-case JSON escaping of
  // every captured response byte. Bound capture before a completed record exists.
  const prefixLimit = Math.min(Math.floor(limit / 2), Math.floor((HISTORY_LIMITS.recordBytes - 65536 - limit / 2) / 6) - tailLimit);
  let finished = false, prefixBytes = 0, tailBytes = 0, tailOffset = 0;
  let prefix = null, tail = null, seenBytes = 0, detachAbort = null;
  const secrets = [];
  let secretBytes = 0;
  function protect(value) {
    if (finished || typeof value !== 'string' || value.length < 4 || value.length >= 8192 || secrets.length >= 16 || secrets.includes(value)) return;
    const bytes = Buffer.byteLength(value);
    if (secretBytes + bytes > 16384) return;
    secrets.push(Buffer.from(value, 'utf8').toString('utf8')); secretBytes += bytes;
  }
  protect(secret); secret = null;
  let fields = {};
  for (const key of ['messages', 'system', 'instructions', 'input', 'contents', 'systemInstruction', 'tools']) {
    if (body[key] !== undefined) fields[key] = body[key];
  }
  let snapshot = privacy.sanitizeRequest(fields, limit / 2, secrets);
  const safeMetadata = value => privacy.sanitize(String(value || '').slice(0, 256), 2048, secrets).value;
  const record = {
    id: randomUUID(), ownerId: null, createdAt: new Date().toISOString(), endpoint: safeMetadata(endpoint),
    clientName: /claude|codex|cursor|gemini|cline|opencode/i.exec((userAgent || '').slice(0, 512))?.[0]?.toLowerCase() || null,
    requestedModel: safeMetadata(body.model),
    request: snapshot.value, truncated: snapshot.truncated, attempts: [],
  };
  // Do not retain the input body, its nested fields or credentials in closures.
  fields = null; snapshot = null; body = null; userAgent = null; config = null;
  const started = performance.now();
  function observe(chunk) {
    try {
      if (!record.ttftMs) record.ttftMs = performance.now() - started;
      seenBytes += chunk.byteLength;
      const copied = Math.min(chunk.byteLength, prefixLimit - prefixBytes);
      if (copied) {
        prefix ||= Buffer.allocUnsafeSlow(prefixLimit);
        prefix.set(chunk.subarray(0, copied), prefixBytes); prefixBytes += copied;
      }
      // Only the bytes beyond the prefix go into the fixed-size tail ring.
      if (copied === chunk.byteLength) return;
      tail ||= Buffer.allocUnsafeSlow(tailLimit);
      const rest = chunk.subarray(copied);
      if (rest.byteLength >= tailLimit) {
        tail.set(rest.subarray(-tailLimit)); tailOffset = 0; tailBytes = tailLimit;
      } else {
        const first = Math.min(rest.byteLength, tailLimit - tailOffset);
        tail.set(rest.subarray(0, first), tailOffset);
        if (first < rest.byteLength) tail.set(rest.subarray(first), 0);
        tailOffset = (tailOffset + rest.byteLength) % tailLimit;
        tailBytes = Math.min(tailLimit, tailBytes + rest.byteLength);
      }
    } catch { discard(); }
  }
  function cleanup() {
    prefix = null; tail = null; secrets.length = 0; secretBytes = 0;
    record.request = null; record.responsePrefix = ''; record.responseTail = '';
    if (detachAbort) { detachAbort(); detachAbort = null; }
    const callback = release;
    release = null; enqueue = null;
    callback?.();
  }
  function discard() {
    if (finished) return;
    finished = true; cleanup();
  }
  function finish(status, error = null) {
    if (finished) return;
    finished = true;
    try {
      record.status = status; record.durationMs = performance.now() - started;
      record.truncated ||= seenBytes > prefixLimit;
      record.responsePrefix = prefix ? prefix.toString('utf8', 0, prefixBytes) : '';
      record.responseTail = '';
      if (tailBytes) {
        const ordered = tailBytes < tailLimit || tailOffset === 0
          ? tail.subarray(0, tailBytes)
          : Buffer.concat([tail.subarray(tailOffset), tail.subarray(0, tailOffset)], tailLimit);
        record.responseTail = ordered.toString('utf8');
      }
      for (const secret of secrets) {
        record.responsePrefix = record.responsePrefix.split(secret).join('[REDACTED]');
        record.responseTail = record.responseTail.split(secret).join('[REDACTED]');
      }
      if (error) record.error = privacy.sanitize({ category: status, message: String(error.message || error).slice(0, 1000) }, 4096, secrets).value;
      enqueue(record);
    } catch { /* history is expendable */ }
    finally { cleanup(); }
  }
  return {
    discard, protect,
    identify(id) { if (!finished) record.ownerId = id || null; },
    route(provider, model) { if (!finished) { record.provider = safeMetadata(provider); record.model = safeMetadata(model); } },
    attempt(provider, model) {
      if (finished) return null;
      record.provider = safeMetadata(provider); record.model = safeMetadata(model);
      if (record.attempts.length >= 16) return null;
      const attempt = { provider: record.provider, model: record.model };
      record.attempts.push(attempt);
      return attempt;
    },
    result(attempt, status) { if (!finished && attempt) attempt.httpStatus = status; },
    finish,
    wrap(response, signal) {
      if (finished) return response;
      const ok = response.ok;
      record.httpStatus = response.status;
      record.sse = /text\/event-stream/.test(response.headers.get('content-type') || '');
      if (!response.body) { finish(ok ? 'success' : 'failed'); return response; }
      const responseInit = { status: response.status, statusText: response.statusText, headers: response.headers };
      let reader = response.body.getReader();
      response = null;
      const onAbort = () => finish('aborted');
      if (signal) {
        const observedSignal = signal;
        observedSignal.addEventListener('abort', onAbort, { once: true });
        detachAbort = () => observedSignal.removeEventListener('abort', onAbort);
        if (observedSignal.aborted) onAbort();
      }
      signal = null;
      function releaseReader() {
        const current = reader; reader = null;
        try { current?.releaseLock(); } catch { /* cancelled read may still be pending */ }
      }
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) { releaseReader(); finish(ok ? 'success' : 'failed'); controller.close(); }
            else { controller.enqueue(value); if (!finished) observe(value); }
          } catch (error) { releaseReader(); finish('interrupted', error); controller.error(error); }
        },
        cancel(reason) {
          finish('aborted');
          const current = reader; reader = null;
          return current?.cancel(reason).finally(() => { try { current.releaseLock(); } catch { /* pending read */ } });
        },
      }, { highWaterMark: 0 });
      return new Response(stream, responseInit);
    },
  };
}
