import { describe, expect, test } from 'vitest';

import { getOAuthAuthorizationPageCsp } from '@/lib/oauth/authorization-csp';

describe('OAuth authorization page CSP', () => {
  test('redirect URIのpathではなく動的loopback originだけをform-actionへ加える', () => {
    const csp = getOAuthAuthorizationPageCsp('http://127.0.0.1:53124/callback/codex');

    expect(csp).toContain("form-action 'self' http://127.0.0.1:53124");
    expect(csp).not.toContain('/callback/codex');
    expect(csp).not.toContain('?');
  });

  test.each([
    'http://localhost/callback/codex',
    'http://[::1]/callback/codex',
    'https://127.0.0.1/callback/codex',
    'http://127.0.0.1:0/callback/codex',
    'http://192.0.2.10/callback/codex',
  ])('許可されないredirect URI %s をCSPへ変換しない', (redirectUri) => {
    expect(() => getOAuthAuthorizationPageCsp(redirectUri)).toThrow();
  });
});
