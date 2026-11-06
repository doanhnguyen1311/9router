// Synthetic OpenAI-compatible upstream for v2 proxy integration tests.
// All endpoint/key-like strings are fixtures, never production credentials.
const http = require("node:http");

const EXPECTED_AUTH = "Bearer fixture-upstream-key";
const FAKE_PRIVATE_ENDPOINT = "https://should-never-leak.example/v1";
const FAKE_PRIVATE_KEY = "fixture-secret-that-must-not-leak";

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/chat/completions?trace=simulation") {
    res.writeHead(501, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Endpoint not defined" } }));
    return;
  }

  let raw = "";
  if (req.body !== undefined) {
    raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  } else {
    for await (const chunk of req) raw += chunk;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `${FAKE_PRIVATE_ENDPOINT} ${FAKE_PRIVATE_KEY}` } }));
    return;
  }

  if (req.headers.authorization !== EXPECTED_AUTH || req.headers["x-api-key"] === "fixture-facade-key") {
    res.writeHead(401, { "content-type": "application/json", "x-private-upstream": FAKE_PRIVATE_ENDPOINT });
    res.end(JSON.stringify({ error: { message: `${FAKE_PRIVATE_ENDPOINT} ${FAKE_PRIVATE_KEY}` } }));
    return;
  }

  if (body.model === "error-leak") {
    res.writeHead(500, { "content-type": "application/json", "x-private-upstream": FAKE_PRIVATE_ENDPOINT });
    res.end(JSON.stringify({ error: { message: `${FAKE_PRIVATE_ENDPOINT} ${FAKE_PRIVATE_KEY}` } }));
    return;
  }

  if (body.model === "sse-error-leak") {
    res.writeHead(200, { "content-type": "text/event-stream", server: "private-upstream" });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    res.end(`event: error\ndata: {"error":{"message":"${FAKE_PRIVATE_ENDPOINT} ${FAKE_PRIVATE_KEY}"}}\n\n`);
    return;
  }

  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    server: "private-upstream",
    "x-private-upstream": FAKE_PRIVATE_ENDPOINT,
  });
  res.end(JSON.stringify({
    id: "v2-fixture",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "hello through v2" }, finish_reason: "stop" }],
  }));
});

server.listen(process.env.PORT || 4600);
