// Local fixture for the gateway's existing OpenAI-compatible protocol.
const http = require('node:http');
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/chat/completions') { res.writeHead(501); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (body.model === 'rate-limited' || body.model === 'openai/gpt-5.1') {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Rate limit fixture', code: 'rate_limit' } })); return;
  }
  const content = /^(openai|moonshotai)\//.test(body.model || '') ? 'effort:' + (body.reasoning?.effort || body.reasoning_effort || 'default') : null;
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = [
      { id: 'fixture', model: 'model', choices: [{ index: 0, delta: { role: 'assistant', content: content || 'hello ' }, finish_reason: null }] },
      { id: 'fixture', model: 'model', choices: [{ index: 0, delta: { content: content ? '' : 'from fixture' }, finish_reason: null }] },
      { id: 'fixture', model: 'model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 4 } },
    ];
    for (const frame of frames) { res.write('data: ' + JSON.stringify(frame) + '\n\n'); await new Promise(r => setTimeout(r, 2)); }
    res.end('data: [DONE]\n\n'); return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'model', choices: [{ index: 0, message: { role: 'assistant', content: content || 'hello from fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 4 } }));
});
server.listen(process.env.PORT || 4500);
