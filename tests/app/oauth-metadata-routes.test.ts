import { afterEach, expect, test } from 'vitest';

import { GET as protectedResourceMetadata } from '@/app/.well-known/oauth-protected-resource/api/mcp/route';
import { GET as authorizationServerMetadata } from '@/app/.well-known/oauth-authorization-server/route';

const originalEnv = { ...process.env };

afterEach(() => { process.env = { ...originalEnv }; });

function setProductionOAuthEnvironment() {
  process.env.MCP_OAUTH_ENABLED = '1';
  process.env.AUTH_REQUIRED = '1';
  process.env.MCP_PUBLIC_URL = 'https://ltm.okakam.net';
}

test('metadataはDCRとPKCE S256を広告しCIMDを広告しない', async () => {
  setProductionOAuthEnvironment();
  const response = await authorizationServerMetadata();
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(body).toMatchObject({
    issuer: 'https://ltm.okakam.net',
    registration_endpoint: 'https://ltm.okakam.net/oauth/register',
    code_challenge_methods_supported: ['S256'],
  });
  expect(body).not.toHaveProperty('client_id_metadata_document_supported');
});

test('protected resource metadataはMCP resourceとauthorization serverを返す', async () => {
  setProductionOAuthEnvironment();
  const response = await protectedResourceMetadata();
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    resource: 'https://ltm.okakam.net/api/mcp',
    authorization_servers: ['https://ltm.okakam.net'],
    scopes_supported: ['mcp:access'],
    resource_name: 'long-term-memory',
  });
});

test('OAuth disabled時のmetadataは404で、設定不正時は500になる', async () => {
  process.env.MCP_OAUTH_ENABLED = '0';
  process.env.AUTH_REQUIRED = '0';
  process.env.MCP_PUBLIC_URL = 'http://localhost:3000';
  await expect(authorizationServerMetadata()).resolves.toMatchObject({ status: 404 });

  process.env.MCP_OAUTH_ENABLED = '1';
  process.env.AUTH_REQUIRED = '0';
  await expect(authorizationServerMetadata()).resolves.toMatchObject({ status: 500 });
});
