# Reopened Phase 4 validation plan

1. Re-run MCP connector authentication, scope, cross-project isolation, redaction, revocation, rate-limit and plan-submission tests against the corrected Planning/Execution state machine.
2. Verify a submitted ChatGPT draft still requires structured option selection and dashboard approval before `prepare_execution` becomes available.
3. Keep ChatGPT Web in Connector Management as an interactive OAuth/MCP connector, not an automated LLM Provider.
4. Do not use cookies, session extraction, CAPTCHA/PoW bypass, unauthorized browser automation or rate-limit evasion.
5. Pair a real authenticated ChatGPT Web session only with a reachable non-production HTTPS endpoint and a scoped test Project.
6. Prove it can read only that Project, submit a schema-valid draft and cannot bypass approval or worker authorization.
7. Keep the Phase 4 gate `BLOCKED` if the real supported E2E environment is unavailable; automated tests alone are insufficient.
