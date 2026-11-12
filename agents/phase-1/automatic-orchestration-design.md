# Phase 1 automatic planning orchestration design

Starting checkpoint: `22c4bfc3cb629969e8a6604733d03703a9b4a34a`.

## Corrected scope

The original Phase 1 backend could generate a structured plan only through the Project Planning API. The reopened scope connects that capability to authenticated inference requests without adding approval UI or Codex execution.

## Request decision

- `OFF`: preserve the existing inference path byte-for-byte.
- `MANUAL`: enter planning only when the client sends `X-9Router-Planning: plan`.
- `ADAPTIVE`: automatically enter planning for a request whose newest semantic input is user text.
- Tool-only continuations, system-only requests and existing bypass probes continue through the legacy path.
- A planning-enabled key must still be active, unexpired, Project-enabled and assigned to an active Project where its owner has writer access.

## Planning response protocol

An intercepted request returns `202 Accepted`, never waits for human approval, and does not call the requested execution model. The JSON envelope contains a stable `planId`, status/version/revision, interpreted intent, clarification questions, options, recommended option, and advertised version-aware actions. `Cache-Control: private, no-store` prevents plan state from being cached. Phase 2 adds the mutation endpoint for those actions.

The response is a 9Router extension deliberately limited to opted-in keys. Existing keys and `OFF` mode keep the existing OpenAI/Claude/Gemini/Ollama response formats.

## Persistence and replay safety

Migration 009 adds `planningRequestBindings`. It stores only a hash of an optional client idempotency key, binds it to one API Key, Project and Plan, and prevents a retry from paying for or creating a second plan. No plaintext API key or client idempotency value is stored.

## Failure policy

- Security, permission and invalid-configuration failures always fail closed.
- Provider/output/timeout failures obey the administrator's `FAIL_CLOSED` or `LEGACY_PATH` policy.
- A failed initial planning attempt remains durably audited as `FAILED`.

## Phase 1 acceptance criteria

- An `ADAPTIVE` API Key request creates and returns real structured options before inference execution.
- `MANUAL` requires the explicit planning signal.
- `OFF` and unassigned legacy keys remain unchanged.
- The created plan records its API Key association and survives restart/export/import.
- Replayed idempotent requests reuse the same Plan.
- Cross-key and cross-Project plan reads are denied.
- Planning provider failure follows the configured policy.
- Focused and full regressions, build, lint, migration, security and performance checks pass before the Phase is closed again.
