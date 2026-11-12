# Phase 4 — ChatGPT Web MCP connector

Status: `BLOCKED`

Implementation checkpoint: `b2242a36` (`feat: add phase 4 ChatGPT MCP connector`).

Implemented scope: OAuth/PKCE protected, project-scoped Streamable HTTP MCP; seven bounded read tools; separately authorized `submit_plan_draft`; expiration, revocation, rate limits and audit; no session hijacking, cookie extraction, CAPTCHA/PoW bypass, unauthorized browser automation or rate-limit evasion.

Automated evidence is clean: 1,455/1,455 suites, 4,684 passed, 0 failed; build/typecheck PASS; ESLint 0 errors; dependency audit 0 vulnerabilities; local MCP p95 0.58 ms.

Post-Phase-3 revalidation is also clean: 1,466/1,466 suites and 4,704 tests passed with zero failures; the focused connector → approval/execution compatibility bundle passed 13/13. See [`post-phase-3-validation.md`](./post-phase-3-validation.md).

The gate is not PASS because a real ChatGPT Web connector session could not be configured in the current environment. The supported protocol flow is tested end-to-end at the HTTP handler boundary, but “ChatGPT Web reads the intended Project” remains `NOT TESTED`, which is a mandatory acceptance criterion.
