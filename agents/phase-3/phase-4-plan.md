# Phase 4 implementation plan

1. Read the `codex-with-chatgpt` integration instructions and analyze the referenced upstream repository and supported ChatGPT/MCP protocols.
2. Audit existing 9Router MCP routes and Project Memory/File Intelligence/Graph APIs for reusable boundaries.
3. Design scoped connector credentials, expiry/revocation/rate limits and auditable project isolation.
4. Implement read-only context tools plus a separately authorized, schema-validated `submit_plan_draft` operation.
5. Expose ChatGPT Web as an interactive connector, never as an automated LLM API provider or a route around approval.
6. Test authentication, authorization, isolation, filtering, prompt-injection boundaries, rate limits, revocation, failure handling, plan submission and approval integration.
7. Run full build/lint/regression/security checks and create the Phase 4 checkpoint only if its Quality Gate passes.
