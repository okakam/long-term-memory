import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';

import { POST as register } from '@/app/oauth/register/route';
import { GET as authorizeGet, POST as authorizePost } from '@/app/oauth/authorize/route';
import { POST as tokenPost } from '@/app/oauth/token/route';
import { POST as revokePost } from '@/app/oauth/revoke/route';
import { setFirebaseAuthForTests, type FirebaseAdminAuth } from '@/lib/auth/firebase';
import { migrateAuthLocal } from '@/lib/auth/migrate';
import { setOAuthStoreForTests, resetOAuthStoreForTests } from '@/lib/oauth/store';
import { SqliteOAuthStore } from '@/lib/oauth/sqlite-store';
import { LocalIndexStore } from '@/lib/storage/local-index';

const originalEnv = { ...process.env };
const callback = 'http://127.0.0.1/callback/codex';
const registeredCallbackWithPort = 'http://127.0.0.1:49210/callback/codex';
const authorizationCallbackWithPort = 'http://127.0.0.1:53124/callback/codex';
const verifier = 'verifier-that-is-long-enough-for-pkce-0123456789';
const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
let db: Database.Database | undefined;

const auth: FirebaseAdminAuth = {
  verifyIdToken: vi.fn(async () => ({ uid: 'bearer-user', email: 'bearer@okakam.net' })),
  verifySessionCookie: vi.fn(async () => ({ uid: 'user-1', email: 'user-1@okakam.net' })),
  createSessionCookie: vi.fn(async () => 'session'),
};

afterEach(async () => {
  await resetOAuthStoreForTests();
  db?.close();
  db = undefined;
  setFirebaseAuthForTests(null);
  process.env = { ...originalEnv };
});

async function setup() {
  process.env.MCP_OAUTH_ENABLED = '1';
  process.env.AUTH_REQUIRED = '1';
  process.env.MCP_PUBLIC_URL = 'https://ltm.okakam.net';
  db = new Database(':memory:');
  migrateAuthLocal(db);
  setOAuthStoreForTests(new SqliteOAuthStore(new LocalIndexStore(db)));
  setFirebaseAuthForTests(auth);
}

async function registerClient(redirectUri = callback) {
  const response = await register(new Request('https://ltm.okakam.net/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
    body: JSON.stringify({ client_name: 'Codex', redirect_uris: [redirectUri] }),
  }));
  expect(response.status).toBe(201);
  return response.json() as Promise<{ client_id: string }>;
}

function authorizeUrl(clientId: string, redirectUri = callback) {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'mcp:access',
    resource: 'https://ltm.okakam.net/api/mcp',
    state: 'state-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `https://ltm.okakam.net/oauth/authorize?${query}`;
}

test('DCRは許可されたloopback callbackだけを登録し、unsupported metadataを拒否する', async () => {
  await setup();
  const valid = await register(new Request('https://ltm.okakam.net/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Codex',
      redirect_uris: [callback],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:access',
      application_type: 'native',
    }),
  }));
  expect(valid.status).toBe(201);
  const registration = await valid.json();
  expect(registration.client_id).toMatch(/^ltm_cli_/);
  expect(registration.scope).toBe('mcp:access');
  expect(registration.application_type).toBe('native');

  const validDynamicPort = await register(new Request('https://ltm.okakam.net/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:53124/callback/codex'] }),
  }));
  expect(validDynamicPort.status).toBe(201);

  for (const metadata of [
    { redirect_uris: ['http://127.0.0.1:0/callback'] },
    { redirect_uris: ['http://localhost/callback'] },
    { redirect_uris: ['http://[::1]/callback'] },
    { redirect_uris: [callback], grant_types: ['client_credentials'] },
    { redirect_uris: [callback], response_types: ['token'] },
    { redirect_uris: [callback], token_endpoint_auth_method: 'client_secret_post' },
    { redirect_uris: [callback], scope: 'mcp:write' },
    { redirect_uris: [callback], application_type: 'web' },
  ]) {
    const response = await register(new Request('https://ltm.okakam.net/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(metadata),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_client_metadata' });
  }
});

test('authorization code、PKCE token exchange、refresh、revokeをform-urlencodedで処理する', async () => {
  await setup();
  const client = await registerClient(registeredCallbackWithPort);
  const authorization = await authorizeGet(new Request(
    authorizeUrl(client.client_id, authorizationCallbackWithPort),
    { headers: { cookie: 'ltm_session=session' } },
  ));
  expect(authorization.status).toBe(200);
  const html = await authorization.text();
  const transactionId = html.match(/name="transaction_id" value="([^"]+)"/)?.[1];
  const csrfToken = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  expect(transactionId).toMatch(/^ltm_oatx_/);
  expect(csrfToken).toMatch(/^ltm_csrf_/);

  const approved = await authorizePost(new Request('https://ltm.okakam.net/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `ltm_oauth_tx=${encodeURIComponent(transactionId!)}; ltm_oauth_csrf=${encodeURIComponent(csrfToken!)}; ltm_session=session`,
    },
    body: new URLSearchParams({ transaction_id: transactionId!, csrf_token: csrfToken!, decision: 'approve' }),
  }));
  expect(approved.status).toBe(302);
  const callbackLocation = new URL(approved.headers.get('location')!);
  expect(callbackLocation.origin).toBe('http://127.0.0.1:53124');
  expect(callbackLocation.port).toBe('53124');
  expect(callbackLocation.searchParams.get('state')).toBe('state-1');
  const code = callbackLocation.searchParams.get('code');
  expect(code).toMatch(/^ltm_oac_/);

  const exchanged = await tokenPost(new Request('https://ltm.okakam.net/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: code!,
      redirect_uri: authorizationCallbackWithPort,
      code_verifier: verifier,
    }),
  }));
  expect(exchanged.status).toBe(200);
  const token = await exchanged.json() as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
  expect(token).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
  expect(token.access_token).toMatch(/^ltm_oat_/);

  const refreshed = await tokenPost(new Request('https://ltm.okakam.net/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token.refresh_token }),
  }));
  expect(refreshed.status).toBe(200);
  const rotated = await refreshed.json() as { access_token: string; refresh_token: string };
  expect(rotated.access_token).not.toBe(token.access_token);

  const revoked = await revokePost(new Request('https://ltm.okakam.net/oauth/revoke', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: rotated.refresh_token, token_type_hint: 'refresh_token' }),
  }));
  expect(revoked.status).toBe(204);
  expect(revoked.headers.get('cache-control')).toBe('no-store');
});

test('同意POST時にFirebase sessionが消えた場合はcodeを発行せずsign-inへ戻す', async () => {
  await setup();
  const client = await registerClient();
  const authorization = await authorizeGet(new Request(authorizeUrl(client.client_id), { headers: { cookie: 'ltm_session=session' } }));
  const html = await authorization.text();
  const transactionMatch = html.match(/name="transaction_id" value="([^"]+)"/);
  const csrfMatch = html.match(/name="csrf_token" value="([^"]+)"/);
  expect(transactionMatch).not.toBeNull();
  expect(csrfMatch).not.toBeNull();
  const transactionId = transactionMatch?.[1] ?? '';
  const csrfToken = csrfMatch?.[1] ?? '';
  setFirebaseAuthForTests(null);

  const response = await authorizePost(new Request('https://ltm.okakam.net/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `ltm_oauth_tx=${encodeURIComponent(transactionId)}; ltm_oauth_csrf=${encodeURIComponent(csrfToken)}`,
    },
    body: new URLSearchParams({ transaction_id: transactionId, csrf_token: csrfToken, decision: 'approve' }),
  }));
  expect(response.status).toBe(302);
  expect(new URL(response.headers.get('location')!).pathname).toBe('/sign-in');
  expect(new URL(response.headers.get('location')!).searchParams.get('oauth_transaction')).toBe(transactionId);
});

test('token/revoke endpointはform以外を拒否し、unknown revoke tokenは存在を開示しない', async () => {
  await setup();
  const tokenResponse = await tokenPost(new Request('https://ltm.okakam.net/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }));
  expect(tokenResponse.status).toBe(400);
  const revokeResponse = await revokePost(new Request('https://ltm.okakam.net/oauth/revoke', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'ltm_oat_unknown' }),
  }));
  expect(revokeResponse.status).toBe(204);
});
