# API Key Planning permission update

The Planning Provider, Planning Model, context budget, expiration and failure
policy remain administrator-controlled fields. A new additive `apiKeys.planningSelfServiceEnabled`
column defaults to `0` for old and new keys.

When the administrator enables the permission, the API-key owner can only
toggle `planningEnabled` and `planningMode` through `/api/key-usage`. Backend
validation rejects provider/model/policy/limit changes even if the dashboard is
bypassed. The owner cannot enable Planning until the administrator has saved a
Provider and Model. Approval remains mandatory.

The Key Usage page shows either an authorized switch or an “Admin controlled”
state. The full planning configuration remains on the dashboard API-key
management screen.
