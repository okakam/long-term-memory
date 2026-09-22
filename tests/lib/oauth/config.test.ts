import { afterEach, describe, expect, test } from 'vitest';

import { getOAuthConfiguration, getOAuthRateLimitKey, getOAuthRateLimitPolicy } from '@/lib/oauth/config';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('OAuth configuration', () => {
  test('OAuth有効時はHTTPS issuerとAUTH_REQUIRED=1を要求する', () => {
    process.env.MCP_OAUTH_ENABLED = '1';
    process.env.AUTH_REQUIRED = '0';
    process.env.MCP_PUBLIC_URL = 'http://example.test';

    expect(() => getOAuthConfiguration()).toThrow(/AUTH_REQUIRED=1/);
  });

  test('OAuth有効時はquery、fragment、非HTTPS issuerを拒否する', () => {
    process.env.MCP_OAUTH_ENABLED = '1';
    process.env.AUTH_REQUIRED = '1';
    process.env.MCP_PUBLIC_URL = 'https://example.test/base?tenant=one';

    expect(() => getOAuthConfiguration()).toThrow(/query|fragment|origin/i);
  });

  test('issuerとresource metadata URLを正規化する', () => {
    process.env.MCP_OAUTH_ENABLED = '1';
    process.env.AUTH_REQUIRED = '1';
    process.env.MCP_PUBLIC_URL = 'https://ltm.okakam.net/';

    const config = getOAuthConfiguration();

    expect(config.enabled).toBe(true);
    expect(config.issuer.origin).toBe('https://ltm.okakam.net');
    expect(config.resource.href).toBe('https://ltm.okakam.net/api/mcp');
    expect(config.metadataUrl.href).toBe('https://ltm.okakam.net/.well-known/oauth-protected-resource/api/mcp');
    expect(config.accessTokenTtlSeconds).toBe(900);
    expect(config.refreshTokenTtlSeconds).toBe(2_592_000);
    expect(config.authorizationCodeTtlSeconds).toBe(60);
    expect(config.transactionTtlSeconds).toBe(600);
  });

  test('rate limit policyはendpointごとの固定windowとscopeを返す', () => {
    expect(getOAuthRateLimitPolicy('register')).toMatchObject({ windowSeconds: 600, limit: 30, scope: 'global' });
    expect(getOAuthRateLimitPolicy('authorize')).toMatchObject({ windowSeconds: 600, limit: 20, scope: 'ip' });
    expect(getOAuthRateLimitPolicy('token')).toMatchObject({ windowSeconds: 600, limit: 60, scope: 'client-ip' });
    expect(getOAuthRateLimitPolicy('revoke')).toMatchObject({ windowSeconds: 600, limit: 30, scope: 'ip' });
  });

  test('X-Forwarded-Forは先頭IPだけをhash化し、認可identityには使わない', () => {
    const request = new Request('https://example.test/oauth/token', {
      headers: { 'x-forwarded-for': '203.0.113.10, 198.51.100.7' },
    });

    const key = getOAuthRateLimitKey(request, 'client-1');

    expect(key.clientId).toBe('client-1');
    expect(key.ipHash).toMatch(/^[a-f0-9]{64}$/);
    expect(key.ipHash).not.toContain('203.0.113.10');
  });
});
