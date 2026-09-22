import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';

import { migrateAuthLocal } from '@/lib/auth/migrate';
import { LocalIndexStore } from '@/lib/storage/local-index';
import { hashOpaqueSecret } from '@/lib/oauth/crypto';
import { SqliteOAuthStore } from '@/lib/oauth/sqlite-store';
import type {
  OAuthAccessToken,
  OAuthAuthorizationCode,
  OAuthClient,
  OAuthGrantSummary,
  OAuthRefreshToken,
  OAuthTokenSet,
} from '@/lib/oauth/types';

const databases: Database.Database[] = [];

function client(): OAuthClient {
  return {
    id: 'client-1',
    client_id: 'client-1',
    client_name: 'Codex',
    redirect_uris: ['http://127.0.0.1/callback/abc'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    created_at: '2026-09-21T00:00:00.000Z',
  };
}

function authorizationCode(): OAuthAuthorizationCode {
  return {
    id: 'code-id',
    code_hash: hashOpaqueSecret('code-secret'),
    code_prefix: 'ltm_oac_code',
    user_id: 'user-1',
    client_id: 'client-1',
    grant_id: 'grant-1',
    redirect_uri: 'http://127.0.0.1/callback/abc',
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
    scope: 'mcp:access',
    resource: 'https://ltm.okakam.net/api/mcp',
    created_at: '2026-09-21T00:00:00.000Z',
    expires_at: '2099-09-21T00:01:00.000Z',
    consumed_at: null,
    revoked_at: null,
  };
}

function tokenSet(overrides: Partial<OAuthTokenSet> = {}): OAuthTokenSet {
  const grant: OAuthGrantSummary = {
    id: 'grant-1',
    user_id: 'user-1',
    client_id: 'client-1',
    client_name: 'Codex',
    scope: 'mcp:access',
    resource: 'https://ltm.okakam.net/api/mcp',
    created_at: '2026-09-21T00:00:00.000Z',
    last_used_at: null,
    revoked_at: null,
  };
  const accessToken: OAuthAccessToken = {
    id: 'access-1',
    token_hash: hashOpaqueSecret('access-secret'),
    token_prefix: 'ltm_oat_acce',
    user_id: 'user-1',
    client_id: 'client-1',
    grant_id: 'grant-1',
    scope: 'mcp:access',
    resource: grant.resource,
    created_at: grant.created_at,
    last_used_at: null,
    expires_at: '2026-09-21T00:15:00.000Z',
    revoked_at: null,
  };
  const refreshToken: OAuthRefreshToken = {
    id: 'refresh-1',
    token_hash: hashOpaqueSecret('refresh-secret'),
    token_prefix: 'ltm_ort_refr',
    family_id: 'family-1',
    user_id: 'user-1',
    client_id: 'client-1',
    grant_id: 'grant-1',
    scope: 'mcp:access',
    resource: grant.resource,
    created_at: grant.created_at,
    expires_at: '2026-10-21T00:00:00.000Z',
    last_used_at: null,
    replaced_at: null,
    revoked_at: null,
  };
  return { grant, accessToken, refreshToken, ...overrides };
}

async function setup(): Promise<{ db: Database.Database; store: SqliteOAuthStore }> {
  const db = new Database(':memory:');
  databases.push(db);
  migrateAuthLocal(db);
  return { db, store: new SqliteOAuthStore(new LocalIndexStore(db)) };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

test('SQLite OAuth storeはclient/codeを一回だけ消費する', async () => {
  const { store } = await setup();
  await store.registerClient(client());
  await store.createTokenSet(tokenSet());
  await store.createAuthorizationCode(authorizationCode());

  await expect(store.getClient('client-1')).resolves.toMatchObject({ client_name: 'Codex' });
  await expect(store.consumeAuthorizationCode({
    codeHash: hashOpaqueSecret('code-secret'),
    clientId: 'client-1',
    redirectUri: 'http://127.0.0.1/callback/abc',
  })).resolves.toMatchObject({ user_id: 'user-1' });
  await expect(store.consumeAuthorizationCode({
    codeHash: hashOpaqueSecret('code-secret'),
    clientId: 'client-1',
    redirectUri: 'http://127.0.0.1/callback/abc',
  })).resolves.toBeNull();
});

test('SQLite OAuth storeはrefreshをrotateし、family失効とrate limitを原子的に扱う', async () => {
  const { store } = await setup();
  const first = tokenSet();
  await store.registerClient(client());
  await store.createTokenSet(first);
  const next = tokenSet({
    accessToken: { ...first.accessToken, id: 'access-2', token_hash: hashOpaqueSecret('access-next') },
    refreshToken: { ...first.refreshToken, id: 'refresh-2', token_hash: hashOpaqueSecret('refresh-next') },
  });

  await expect(store.rotateRefreshToken({
    refreshTokenHash: first.refreshToken.token_hash,
    clientId: 'client-1',
    resource: null,
    now: '2026-09-21T00:02:00.000Z',
    next,
  })).resolves.toMatchObject({ grant: { id: 'grant-1' } });
  await expect(store.findRefreshTokenByHash(first.refreshToken.token_hash)).resolves.toMatchObject({
    replaced_at: '2026-09-21T00:02:00.000Z',
  });

  await expect(store.rotateRefreshToken({
    refreshTokenHash: first.refreshToken.token_hash,
    clientId: 'client-1',
    resource: null,
    now: '2026-09-21T00:03:00.000Z',
    next,
  })).resolves.toBeNull();
  await expect(store.revokeRefreshTokenFamilyByHash(next.refreshToken.token_hash, '2026-09-21T00:04:00.000Z'))
    .resolves.toBe(true);
  await expect(store.findAccessTokenByHash(first.accessToken.token_hash)).resolves.toMatchObject({
    revoked_at: '2026-09-21T00:04:00.000Z',
  });
  await expect(store.findRefreshTokenByHash(next.refreshToken.token_hash)).resolves.toMatchObject({
    revoked_at: '2026-09-21T00:04:00.000Z',
  });

  const input = { bucket: 'token' as const, keyHash: 'key', limit: 2, windowSeconds: 600 as const, now: '2026-09-21T00:00:00.000Z' };
  await expect(store.takeRateLimit(input)).resolves.toBe(true);
  await expect(store.takeRateLimit(input)).resolves.toBe(true);
  await expect(store.takeRateLimit(input)).resolves.toBe(false);
  await expect(store.takeRateLimit({ ...input, now: '2026-09-21T00:11:00.000Z' })).resolves.toBe(true);
});
