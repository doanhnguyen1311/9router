# Phase 4 implementation design

## Protocol and authentication

The connector exposes stateless MCP Streamable HTTP JSON responses with protocol version `2025-06-18`. OAuth discovery, dynamic client registration, authorization-code + PKCE S256, token rotation and revocation are supported. One-time pairing codes bind an OAuth client to exactly one connector and Project. Access and refresh tokens are stored only as SHA-256 hashes.

## Project-scoped tools

Read-only tools:

- `get_project_overview`
- `search_project_memory`
- `search_project_files`
- `get_symbol_info`
- `get_related_files`
- `get_project_constraints`
- `get_plan_draft`

The separately scoped `submit_plan_draft` tool validates structured Planning output, redacts sensitive text and atomically imports one idempotent draft. It produces only `OPTIONS_READY` or `NEEDS_CLARIFICATION`. Human option selection and approval remain in the authenticated Phase 2 pipeline; Phase 3 still refuses unapproved execution.

Every call rechecks current Project RBAC. Tool schemas are enforced server-side, output is bounded and re-redacted, project content is labeled untrusted, and no tool accepts a caller-selected Project ID.

## Public and administrative surfaces

OAuth and MCP routes bypass the broad API-key middleware only because they authenticate in their own handlers. Connector creation, rotation, audit inspection and revocation remain dashboard-authenticated Project operations. Unrelated `/api/v1` routes retain their previous API-key gate.
