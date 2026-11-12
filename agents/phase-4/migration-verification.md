# Phase 4 migration verification

Schema version changed from 17 to 18 through migration `008-chatgpt-connector`.

Seven additive tables were introduced:

- `chatgptConnectors`
- `chatgptOauthClients`
- `chatgptOauthRequests`
- `chatgptOauthCodes`
- `chatgptOauthTokens`
- `chatgptConnectorAuditLogs`
- `chatgptPlanSubmissions`

They include Project/Plan foreign keys, status and token-type checks, token/code hash uniqueness, idempotent submission uniqueness and expiry/audit indexes.

Verification completed on temporary databases:

- Fresh migrations 1 through 8 during tests and production build.
- Connector, OAuth token, audit and plan-submission persistence.
- Database export/import with no plaintext access token or pairing code.
- `PRAGMA foreign_key_check` returned no violations after restore.
- Production build applied migration 8 in an isolated build database.

The change is additive. A deployment migration will create the normal pre-schema backup before moving a durable database from 17 to 18.
