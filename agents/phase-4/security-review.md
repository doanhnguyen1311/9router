# Phase 4 security review

**Critical: 0. High: 0.**

Implemented controls:

- OAuth discovery, public PKCE clients, exact registered redirect URIs and resource binding.
- One-time five-minute pairing codes with attempt and per-IP rate limits.
- One-hour access tokens, rotating refresh tokens, connector expiry and immediate revocation; only hashes are persisted.
- Project-bound tokens and current-RBAC checks on every tool call.
- Separate `plan.submit` scope and explicit connector flag; read-only connectors never advertise the write tool.
- Bounded request/result sizes, strict top-level tool arguments, tool timeout and authenticated/unauthenticated rate limits.
- Secret/PII redaction, untrusted-content warnings and no filesystem, shell, cookie or browser-session capability.
- Middleware carve-out limited to connector OAuth/MCP routes; connector administration stays dashboard-authenticated.
- Atomic idempotent plan import; no approval or execution transition is exposed through MCP.
- Persistent audit for pairing, tokens and tool calls.

Medium operational hardening:

- Rate-limit buckets are process-local. Multi-instance deployments should use a shared limiter.
- Dynamic OAuth clients are capped at 1,000 but do not yet have an automated retention cleanup policy.
- In-process timeout cannot interrupt a synchronous SQLite statement already executing; production tools use bounded indexed queries and no remote calls.

Actual ChatGPT Web pairing is `NOT TESTED` in this environment. This is a Quality Gate blocker, not a hidden security PASS.
