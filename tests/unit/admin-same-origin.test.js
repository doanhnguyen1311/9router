import { describe, it, expect } from 'vitest';
import { isSameOriginMutation } from '../../src/lib/auth/sameOrigin.js';
const request = (headers = {}, method = 'PUT') => new Request('http://localhost:14991/api/keys/a', { method, headers });
describe('admin mutation origin checks', () => {
  it('uses incoming Host instead of Next internal localhost', () => {
    expect(isSameOriginMutation(request({ host: '127.0.0.1:14991', origin: 'http://127.0.0.1:14991' }))).toBe(true);
    expect(isSameOriginMutation(request({ host: '127.0.0.1:14991', origin: 'http://localhost:14991' }))).toBe(false);
  });
  it('allows preserved proxy Host/protocol and refuses cross-origin or forwarded-host spoofing', () => {
    expect(isSameOriginMutation(request({ host: 'router.example', origin: 'https://router.example', 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(isSameOriginMutation(request({ host: 'router.example', origin: 'https://attacker.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.example' }))).toBe(false);
    expect(isSameOriginMutation(request({ host: 'router.example', origin: 'null' }))).toBe(false);
  });
  it('supports authenticated non-browser callers and read-only requests', () => {
    expect(isSameOriginMutation(request())).toBe(true);
    expect(isSameOriginMutation(request({ origin: 'https://elsewhere.example' }, 'GET'))).toBe(true);
    expect(isSameOriginMutation(request({ origin: 'http://localhost:14991' }))).toBe(true);
  });
});
