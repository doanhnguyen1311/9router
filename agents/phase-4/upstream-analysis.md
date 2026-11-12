# Upstream analysis

Reference: [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt), audited at commit `535a07dbb7aee887924c53767d985c09d405319d`.

The upstream project separates a tiny ChatGPT/Codex control loop from an OAuth-protected MCP data plane. Its important security properties are read-only tools, one-workspace token binding, PKCE S256, dynamic client registration, hashed tokens, rotating refresh tokens, one-time pairing codes, canonical path containment, secret filtering and explicit untrusted-content warnings.

9Router reuses the architecture, not the source implementation:

- The authorization boundary is an existing 9Router Project rather than a local filesystem workspace.
- Context comes from Project Memory, Knowledge Graph and secret-filtered File Intelligence; ChatGPT receives no host filesystem or shell capability.
- Seven tools are read-only. `submit_plan_draft` is the only write tool, has a separate scope and connector flag, validates the Phase 1 schema and cannot select, approve or execute.
- 9Router already owns Planning, Approval and Execution state, so no upstream command-record or tunnel lifecycle code was copied.
- The connector is explicitly interactive. It is not registered as an automated LLM Provider and does not convert a ChatGPT subscription into an API backend.

The temporary audit clone was moved to Trash after analysis. No upstream checkout or credentials were added to this repository.
