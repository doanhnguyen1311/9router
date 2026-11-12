# Reopened Phase 2 rollback strategy

## Application rollback

Revert checkpoint `c0f54b30b149a33279649d7c17afb511867f5c05`.

Effects:

- API-Key sessions lose `links.actions` and the action endpoint.
- Project dashboard's historical Plan APIs and approval workflow remain available.
- Phase 1 automatic requests still return a pollable Planning session, but planning-aware clients must not attempt the removed mutation protocol.

Set affected API Keys to Planning `OFF` before a mixed-version rollback so clients are not handed sessions they cannot complete.

## Database rollback

None. No table, column, constraint, index or migration changed.

## Validation

- Legacy inference paths still return their historical formats.
- Dashboard Project approval still works.
- New action URL returns `404` after rollback rather than partially mutating a Plan.
- Provider/SSE/Project Memory regressions pass.
