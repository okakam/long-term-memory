import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';

import { migrateAuthLocal } from '@/lib/auth/migrate';
import { AuthStore, resetAuthStoreForTests, setAuthStoreForTests } from '@/lib/auth/store';
import type { MemoryService } from '@/lib/memory/service';
import { requireMcpPrincipal } from '@/lib/mcp/principal';
import { resetSessionState } from '@/lib/mcp/session';
import { handleMcpRequest } from '@/lib/mcp/transport';
import { OAuthService, type OAuthAuthorizationRequest } from '@/lib/oauth/service';
import { resetOAuthStoreForTests, setOAuthStoreForTests } from '@/lib/oauth/store';
import { SqliteOAuthStore } from '@/lib/oauth/sqlite-store';
import { LocalIndexStore } from '@/lib/storage/local-index';

const originalEnv = { ...process.env };
const callback = 'http://127.0.0.1/callback/codex';
const verifier = 'verifier-that-is-long-enough-for-pkce-0123456789';
const resource = 'https://example.test/api/mcp';
const service = {
  listProjects: () => [],
  reindex: () => undefined,
} as unknown as MemoryService;

async function setup(): Promise<{ oauth: OAuthService }> {
  process.env.AUTH_REQUIRED = '1';
  process.env.MCP_OAUTH_ENABLED = '1';
  process.env.MCP_PUBLIC_URL = 'https://example.test';

  const authDb = new Database(':memory:');
  const authIndex = new LocalIndexStore(authDb);
  migrateAuthLocal(authDb);
  const authStore = new AuthStore(authIndex);
  setAuthStoreForTests(authStore);
  await authStore.createProject('secure-project', 'owner-1');
  await authStore.addMember('secure-project', 'member-1', 'member');

  const oauthDb = new Database(':memory:');
  migrateAuthLocal(oauthDb);
  const oauthStore = new SqliteOAuthStore(new LocalIndexStore(oauthDb));
  setOAuthStoreForTests(oauthStore);
  return { oauth: new OAuthService({ store: oauthStore }) };
}

async function createOAuthToken(oauth: OAuthService, userId: string): Promise<string> {
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  const input: OAuthAuthorizationRequest = {
    clientId: '',
    redirectUri: callback,
    responseType: 'code',
    scope: 'mcp:access',
    resource,
    state: null,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
  };
  const client = await oauth.registerPublicClient({
    clientName: `client-${userId}`,
    redirectUris: [callback],
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    tokenEndpointAuthMethod: 'none',
  });
  const started = await oauth.beginAuthorization({ ...input, clientId: client.client_id });
  const approval = await oauth.approveAuthorization({
    transactionId: started.transactionId,
    csrfToken: started.csrfToken,
    userId,
    approved: true,
  });
  const token = await oauth.exchangeAuthorizationCode({
    clientId: client.client_id,
    code: approval.code!,
    redirectUri: callback,
    codeVerifier: verifier,
  });
  return token.accessToken;
}

function request(projectId: string, token: string | undefined, message: object): Request {
  return new Request(`https://example.test/api/mcp?project_id=${projectId}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    body: JSON.stringify(message),
  });
}

afterEach(async () => {
  await resetSessionState();
  await resetOAuthStoreForTests();
  await resetAuthStoreForTests();
  process.env = { ...originalEnv };
});

test('OAuth Bearerはmembershipを再評価し、credentialなしはresource metadata付き401になる', async () => {
  const { oauth } = await setup();
  const missing = await handleMcpRequest(request('secure-project', undefined, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
  }), { mode: 'stateless', service });
  expect(missing.status).toBe(401);
  expect(missing.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/api/mcp');

  const ownerToken = await createOAuthToken(oauth, 'owner-1');
  const memberToken = await createOAuthToken(oauth, 'member-1');
  const owner = await handleMcpRequest(request('secure-project', ownerToken, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reindex', arguments: {} },
  }), { mode: 'stateless', service });
  expect(owner.status).toBe(200);

  const member = await handleMcpRequest(request('secure-project', memberToken, {
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'reindex', arguments: {} },
  }), { mode: 'stateless', service });
  expect(member.status).toBe(403);

  await oauth.revokeToken(ownerToken);
  const revoked = await handleMcpRequest(request('secure-project', ownerToken, {
      jsonrpc: '2.0', id: 4, method: 'tools/list', params: {},
  }), { mode: 'stateless', service });
  expect(revoked.status).toBe(401);
  expect(revoked.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/api/mcp');
});

test('Firebase ID token形式はMCP Bearerとして扱わず、OAuthはshared writeを許可しない', async () => {
  const { oauth } = await setup();
  const firebaseLike = await handleMcpRequest(request('secure-project', 'eyJhbGciOiJSUzI1NiJ9.firebase.id-token', {
      jsonrpc: '2.0', id: 5, method: 'tools/list', params: {},
  }), { mode: 'stateless', service });
  expect(firebaseLike.status).toBe(401);

  process.env.LTM_CURATOR_USER_ID = 'curator';
  process.env.LTM_MAINTENANCE_TOKEN = 'maintenance';
  const curatorToken = await createOAuthToken(oauth, 'curator');
  const sharedWrite = await handleMcpRequest(new Request('https://example.test/api/mcp?project_id=__shared__', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${curatorToken}`,
        'x-ltm-maintenance-token': 'maintenance',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 6, method: 'tools/call', params: {
          name: 'remember_user_fact',
          arguments: { name: 'shared', description: 'd', body: 'b', entities: [{ name: 'Entity' }] },
        },
      }),
  }), { mode: 'stateless', service });
  expect(sharedWrite.status).toBe(403);
});

test('principal resolverはPATとOAuthをcredential kind付きで区別する', async () => {
  const { oauth } = await setup();
  const oauthToken = await createOAuthToken(oauth, 'owner-1');
  await expect(requireMcpPrincipal(request('secure-project', oauthToken, {})))
    .resolves.toMatchObject({ userId: 'owner-1', credentialKind: 'oauth' });
});
