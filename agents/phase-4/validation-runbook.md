# Final external validation runbook

Use a non-production HTTPS staging instance with a copied, non-sensitive test Project.

1. Authenticate to 9Router and create a Project connector with read scopes first.
2. Add the returned MCP address as an OAuth connector in ChatGPT Web and complete the one-time pairing flow.
3. In ChatGPT, call `get_project_overview`; verify the exact Project name and expected bounded counts.
4. Attempt a Project-B identifier through Project-A's connector; verify no Project-B data appears.
5. Verify the read-only connector does not advertise `submit_plan_draft`.
6. Create a second connector with plan submission enabled, submit a valid draft and confirm it appears as `OPTIONS_READY` or `NEEDS_CLARIFICATION`.
7. Confirm no approval and no execution record exist until a human uses the authenticated Dashboard.
8. Revoke the connector and verify the next MCP request is unauthorized.
9. Record screenshots/request IDs without tokens or pairing codes, then update `quality-gate.md` only if every check passes.

Do not use production data, browser cookies, session extraction, CAPTCHA/PoW bypass or automated protection evasion.
