# Phase 0 security findings

## Final status

- Critical open: 0.
- High open: 0.
- Medium open: 1 architectural restriction for Phase 4.

## Remediated findings

### Raw usage API keys — CLOSED

- New history rows store an HMAC identifier instead of plaintext.
- Migration 4 rewrites legacy history and removes raw keys from daily rollups.
- Stats/history responses emit masked or non-secret stable labels, never plaintext object keys.
- Summary queries support HMAC plus legacy rows during upgrade.
- Focused attribution, migration, and security-audit tests PASS.

### Vulnerable direct dependency — CLOSED

- Root and CLI `node-forge` declarations are `^1.4.3`; installed production dependency audits report zero vulnerabilities.
- `undici` declaration/install drift was aligned to `^8.12.4`.

### Effective `.env` permissions — CLOSED

- Secret file moved to `/home/doanh/.config/9router/9router.env` on a permission-preserving filesystem.
- Directory mode is `0700`; resolved file mode is `0600`, owned by `doanh:doanh`.
- Repository `.env` is an ignored symlink; before/after SHA-256 is unchanged and contents were not printed.

### Project mutation CSRF gap — CLOSED

- Central Project API identity helper rejects cross-origin browser mutations before identity lookup.
- Same-origin and origin-less authenticated API/CLI calls remain supported.
- Negative and compatibility tests PASS.

### Build opening default user DB — CLOSED

- Root/Bun build scripts now allocate a validated temporary `DATA_DIR` and remove it after the child exits.
- Root and CLI builds were observed using only `/tmp/9router-build-*` SQLite paths.

## Remaining architectural restriction

The existing `chatgpt-web` executor uses cookie/session/browser techniques and must not become the Phase 4 automated planning backend. Phase 4 may only implement a supported, authenticated, project-scoped ChatGPT-assisted MCP workflow with no session hijacking, cookie extraction, CAPTCHA/PoW bypass, or protection evasion.

## Informational debt

- Lockfiles are ignored, so installs are not fully reproducible.
- CI has no complete PR regression/security gate.
- Test runs emit Node experimental/module-type and listener-count warnings.
- Live upstream/API/SSE security behavior was not tested with real credentials.
