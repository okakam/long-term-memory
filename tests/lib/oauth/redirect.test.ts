import { describe, expect, test } from 'vitest';

import { redirectUriMatches, validateDcrRedirectUri } from '@/lib/oauth/redirect';

describe('OAuth redirect URI', () => {
  test('loopback callbackはportだけを可変にする', () => {
    expect(redirectUriMatches(
      'http://127.0.0.1/callback/abc',
      'http://127.0.0.1:53124/callback/abc',
    )).toBe(true);
    expect(redirectUriMatches(
      'http://127.0.0.1:49210/callback/abc',
      'http://127.0.0.1:53124/callback/abc',
    )).toBe(true);
    expect(redirectUriMatches(
      'http://127.0.0.1/callback/abc',
      'http://127.0.0.1:53124/callback/other',
    )).toBe(false);
    expect(redirectUriMatches(
      'http://localhost/callback',
      'http://localhost:53124/callback',
    )).toBe(true);
    expect(redirectUriMatches(
      'http://localhost:49210/callback',
      'http://127.0.0.1:49210/callback',
    )).toBe(false);
    expect(redirectUriMatches(
      'http://localhost/callback',
      'http://localhost:53124/other',
    )).toBe(false);
  });

  test('DCRはportの有無を問わず127.0.0.1とlocalhostの非root callbackを受け入れる', () => {
    expect(validateDcrRedirectUri('http://127.0.0.1/callback/abc').href)
      .toBe('http://127.0.0.1/callback/abc');
    expect(validateDcrRedirectUri('http://127.0.0.1:53124/callback/abc').href)
      .toBe('http://127.0.0.1:53124/callback/abc');
    expect(validateDcrRedirectUri('http://localhost:53124/callback').href)
      .toBe('http://localhost:53124/callback');

    for (const value of [
      'http://127.0.0.1/',
      'http://127.0.0.1:0/callback/abc',
      'http://localhost/',
      'http://localhost:0/callback',
      'http://LOCALHOST/callback',
      'http://localhost.example/callback',
      'https://localhost/callback',
      'http://[::1]/callback/abc',
      'https://127.0.0.1/callback/abc',
      'com.example.app:/callback',
      'http://127.0.0.1/callback/abc#fragment',
      'http://127.0.0.1/callback/abc?state=one',
    ]) {
      expect(() => validateDcrRedirectUri(value), value).toThrow(/redirect/i);
    }
  });

  test('redirect URIの比較はpathとqueryを完全一致させる', () => {
    expect(redirectUriMatches(
      'https://client.example/callback',
      'https://client.example/callback',
    )).toBe(true);
    expect(redirectUriMatches(
      'https://client.example/callback',
      'https://client.example/callback?different=1',
    )).toBe(false);
    expect(redirectUriMatches('not a URL', 'https://client.example/callback')).toBe(false);
  });
});
