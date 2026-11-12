# Reopened Phase 1 security review

## Result

- Critical: 0 open.
- High: 0 open.
- Medium: 0 open.
- Low: 0 open.
- Informational: 2 documented operational choices.

## Verified controls

- Planning is entered only after existing API Key validation, model/access enforcement, bypass handling and quota enforcement.
- A planning session is bound to the exact originating API Key and assigned Project; unauthorized reads return `404` to avoid enumeration.
- Planning still requires owner/editor Project RBAC through the service and repository layers.
- Idempotency and client-session values are SHA-256 hashed with API-Key/purpose domain separation; plaintext API Keys and request identifiers are not stored.
- User input is length-bounded, NUL-cleaned and privacy-redacted before persistence/provider use.
- Project retrieval continues to use bounded context, provenance and existing secret filters.
- Session responses use `private, no-store`; internal errors do not expose upstream messages on 5xx responses.
- Tool/function outputs do not automatically start a new planning task.
- Provider output remains schema-validated before persistence.

## Informational operational choices

1. `LEGACY_PATH` is an explicit administrator-selected availability policy. For a transient Planning Provider failure it permits the historical inference path; the secure default remains `FAIL_CLOSED`. The UI must describe this effect clearly in reopened Phase 2.
2. A `202` planning envelope is a 9Router protocol extension. Only Planning-enabled keys receive it; clients using those keys must understand polling/actions instead of assuming an OpenAI model response.

No session hijacking, browser-cookie extraction, CAPTCHA/PoW bypass or new ChatGPT Web automation was introduced.
