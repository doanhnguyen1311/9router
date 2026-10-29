# Per-API-key reasoning effort

Dashboard → **Endpoint & Key** → a key's **Effort** button manages this policy. Existing keys keep client choice and inherit provider/model defaults until configured. This does not change model access or provider-account access.

Enable **Require API Key** to enforce key policies for every proxy caller. With that setting disabled, anonymous requests retain the existing behavior and have no per-key policy. People sharing one key share its effort policy/default; this feature does not infer individual user identities.

- **Access · User chooses**: the client's explicit effort wins. Without an explicit effort, a model override wins, then the key default, then existing provider/model defaults. The key holder can change their key default on `/key-usage` with their own active API key.
- **No access · Admin chooses**: the model override or locked key default wins over client fields, model suffixes and provider defaults. The key holder cannot edit the policy or their default. Two keys using the same provider account can have different policies.
- Check a concrete `provider/model` before adding an override. Provider aliases such as `cx/` and `kc/` resolve to canonical provider IDs. Effort suffixes and `[1m]` context markers are excluded from override identity. Combos are not override identities: configure their concrete members instead.

Unsupported selected levels return a 400 before credentials/provider dispatch. A combo can try another compatible member using its existing fallback behavior. Levels are not silently raised or lowered. A global default can therefore reject a model that needs a different override.

## Supported levels

The separate conservative catalogue in `open-sse/providers/effortCapabilities.js` is used by the new policy controls. A generic `reasoning: true` capability is insufficient evidence of an effort enum. Unknown/custom provider routes cannot be forced by a key policy; leave client access enabled with no key default for their existing behavior. The legacy provider-wide picker and its existing translator mappings are unchanged.

Examples from the reviewed contracts:

| Route/model | New policy levels |
| --- | --- |
| Codex GPT-6 / GPT-6.1 | `low`, `medium`, `high`, `xhigh`, `max` (the Codex lane does not expose public API `none`) |
| OpenAI GPT-6 Astra / GPT-6.1 Sol | `low`, `medium`, `high`, `xhigh`, `max` |
| OpenAI GPT-6 Sol/Luna / GPT-6.1 Terra | `none` plus the five levels above |
| OpenAI GPT-5.1 | `none`, `low`, `medium`, `high` |
| Claude Sonnet/Opus 4.6 | `low`, `medium`, `high`, `max` |
| New Claude 5 families supported by the catalogue | `low`, `medium`, `high`, `xhigh`, `max` |
| Gemini 3.1 Pro / 3.8 / 4 families | `low`, `medium`, `high` |
| Gemini 3 Pro | `low`, `high` |
| Kimi K3 / K3.1 | `low`, `high`, `max` |
| GLM 5.3 | `low`, `high`, `max` |
| GLM 5.2 | `none`, `high`, `max` |
| DeepSeek V4/Flash | `none`, `low`, `high`, `max` |

Older Claude, Gemini 2.5 and Qwen models can use **token-budget presets**, not native effort enums. The capability API/UI distinguishes `kind: budget`, displays the token count and filters presets to the documented budget range. Gemini 2.5 Pro cannot disable thinking. Binary models offer `thinking` and, where supported, `none`. Kiro's GPT-5.6 lane exposes only `low` through `xhigh`; its existing mapping cannot preserve a distinct `max`.

Gateway routes (Kilo/OpenRouter) use the gateway reasoning shape and are labelled accordingly. A gateway/provider can still reject or translate a supported field. Local tests establish what 9Router sends, not how a remote model spends its reasoning tokens. No paid inference was used to validate this feature.

Reviewed 2026-10-29 against [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning), [OpenAI model catalogue](https://developers.openai.com/api/docs/models), [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Google thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking), [Kimi effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort), [Z.ai thinking](https://docs.z.ai/guides/capabilities/thinking), [DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/), [MiniMax text generation](https://platform.minimax.io/docs/guides/text-generation), [Qwen API](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions), [xAI reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning) and [Kilo gateway](https://kilo.ai/docs/gateway/api-reference), together with the existing executor/registry contracts. Provider/model revisions require revalidation.

## API contract and permissions

`PUT /api/keys/{id}` accepts an optional `effortPolicy`:

```json
{
  "effortPolicy": {
    "allowUserChoice": false,
    "effort": "high",
    "overrides": [
      { "model": "cx/gpt-6.1-sol", "effort": "low" },
      { "model": "kc/moonshotai/kimi-k3", "effort": "max" }
    ]
  }
}
```

Setting this property requires a signed dashboard admin session even if `requireLogin` is disabled. Cross-origin cookie mutations are rejected. Existing dashboard login is the management identity; there is no separate admin/member role table in this codebase. Returns 401 without that session, 400 for malformed/unsupported policies, or 404 for an unknown key. Locked policies require a non-null default. At most 50 unique concrete-model overrides are allowed. The response's `key.effortPolicy` contains canonical model identities. Existing clients omitting the property retain the current policy.

`GET /api/keys/{id}/effort?model=cx%2Fgpt-6.1-sol` requires the same signed session and returns a canonical `model`, `kind`, supported `levels`, `native`, `verified`, and optional `budgets`, `gateway` or `reason`. It performs no inference. Unknown capability contracts return an empty levels array. The key ID is UI context; capability information is model-specific.

`GET /api/key-usage` includes the authenticated key's `effortPolicy`. `PATCH /api/key-usage` accepts `{"selectedEffort":"low"}` or `{"selectedEffort":null}` with the owner's API key in `Authorization: Bearer …`. It returns the updated policy and model access summary. Only `selectedModel` and `selectedEffort` are accepted. Invalid/inactive/expired keys return 401, admin-locked effort returns 403, malformed levels return 400. This cannot grant access, change another key or edit model overrides. The repository checks permission again inside the write transaction to handle concurrent admin revocation.

## Proxy enforcement and storage

The existing key lookup supplies the policy through a request-scoped WeakMap. Effort policy adds no DB reads, I/O, queue or background task to proxy dispatch. Before each concrete fallback target, resolve the policy against that target. Before translation remove client effort controls; after translation/token savers reapply the exact native/gateway fields, including native passthrough. Message content/tool payloads are not deep-cloned. Streaming responses, chunk ordering and response formatting use the existing pipeline.

Enforced policies remove top-level effort/thinking/budget fields, nested native controls, per-message effort overrides and effort controls in Responses `configuration_update` entries (empty updates are removed). Unrelated reasoning metadata and structured-output schemas are retained. Enforced policies reject opaque `previous_response_id`/`conversation` state because its earlier configuration updates cannot be verified; send explicit messages or allow client choice. An enforced manual Claude thinking budget that is not smaller than `max_tokens` is rejected instead of silently clamped. These restrictions also apply to a key default when no explicit client choice was supplied.

Schema **9** adds nullable `apiKeys.effortPolicy TEXT` using the existing additive schema sync and pre-upgrade backup. No existing table is rebuilt or dropped. NULL means `{"allowUserChoice":true,"effort":null,"overrides":[]}`. Corrupt persisted JSON fails closed until an admin repairs the policy. Backup export/import preserves policies; legacy imports without the field inherit the default. No credentials are added to the policy.

## Validation

Run focused tests from `tests/`:

```sh
npx vitest run unit/key-effort.test.js unit/key-effort-db.test.js unit/key-effort-api.test.js unit/codex-native-passthrough-thinking.test.js unit/admin-same-origin.test.js
```

`unit/key-effort-proxy.test.js` runs the real handler, translators and HTTP executor against the checked-in local Postman upstream simulation. It covers simultaneous keys on one account, native client choice, unsupported combo members, 429 fallback, SSE framing, concrete-model overrides and refusal of opaque stored state.

```sh
postman simulation run postman/simulations/chat-history/chat-history.sim.yaml --port 14990 --no-history --output ndjson
# In another shell, from tests/:
HISTORY_TEST_UPSTREAM=http://127.0.0.1:14990/upstream npx vitest run unit/key-effort-proxy.test.js
```

The simulation fixture is shared with Chat History tests and echoes effort for synthetic gateway model requests. Runtime/UI smoke tests must use a temporary `DATA_DIR`, never a production database. No claim of zero overhead or live provider acceptance is made.

Local validation on 2026-10-29: 16 focused/regression files, **192 tests passed**; the optional Chat History performance benchmark was not enabled in that run. Production `npm run build` passed. ESLint passed for the new modules and other changed application files. The existing `EndpointPageClient.js` still reports five React Hooks errors and two warnings; linting the original `HEAD` version reproduced the same findings, outside the added effort controls. Chrome smoke tests on the standalone build with an isolated database verified admin save/reopen, supported model choices, owner lock/unlock, independent key defaults, and rejection of forged cookies, cross-origin writes and attempts to bypass effort management by disabling dashboard login. No browser runtime errors were observed. The real Codex executor also preserved all five selected GPT-6.1 Sol levels in local transformation tests. These checks used synthetic requests and local mocks, not live inference.
