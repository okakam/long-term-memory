import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { migrateAuthLocal } from '@/lib/auth/migrate';
import { LocalIndexStore } from '@/lib/storage/local-index';
import { SqliteOAuthStore } from '@/lib/oauth/sqlite-store';
import {
  DcrClientRegistrationSchema,
  OAuthProtocolError,
  OAuthService,
  type OAuthAuthorizationRequest,
} from '@/lib/oauth/service';
import type { OAuthIdentityProvider } from '@/lib/oauth/identity';

const originalEnv = { ...process.env };
const databases: Database.Database[] = [];

const callback = 'http://127.0.0.1/callback/codex';
const resource = 'https://ltm.okakam.net/api/mcp';
const verifier = 'verifier-that-is-long-enough-for-pkce-0123456789';

const identityProvider: OAuthIdentityProvider = {
  getPrincipal: async () => ({ userId: 'user-1', email: 'user-1@okakam.net' }),
};

function validRequest(clientId: string): OAuthAuthorizationRequest {
  return {
    clientId,
    redirectUri: callback,
    responseType: 'code',
    scope: 'mcp:access',
    resource,
    state: 'state-1',
    codeChallenge: createHash('sha256').update(verifier, 'utf8').digest('base64url'),
    codeChallengeMethod: 'S256',
  };
}

async function setup(): Promise<{ db: Database.Database; service: OAuthService }> {
  process.env.MCP_OAUTH_ENABLED = '1';
  process.env.AUTH_REQUIRED = '1';
  process.env.MCP_PUBLIC_URL = 'https://ltm.okakam.net';
  const db = new Database(':memory:');
  databases.push(db);
  migrateAuthLocal(db);
  const service = new OAuthService({
    store: new SqliteOAuthStore(new LocalIndexStore(db)),
    identityProvider,
  });
  return { db, service };
}

beforeEach(() => { process.env = { ...originalEnv }; });
afterEach(() => {
  process.env = { ...originalEnv };
  while (databases.length > 0) databases.pop()?.close();
});

test('PKCEを照合して一回だけaccess/refresh tokenを発行する', async () => {
  const { service } = await setup();
  const client = await service.registerPublicClient({
    clientName: 'Codex', redirectUris: [callback],
    grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], tokenEndpointAuthMethod: 'none',
  });
  const started = await service.beginAuthorization(validRequest(client.client_id));
  const approval = await service.approveAuthorization({
    transactionId: started.transactionId, csrfToken: started.csrfToken, userId: 'user-1', approved: true,
  });
  const first = await service.exchangeAuthorizationCode({
    clientId: client.client_id, code: approval.code!, redirectUri: callback, codeVerifier: verifier,
  });

  expect(first.accessToken).toMatch(/^ltm_oat_/);
  expect(first.refreshToken).toMatch(/^ltm_ort_/);
  await expect(service.exchangeAuthorizationCode({
    clientId: client.client_id, code: approval.code!, redirectUri: callback, codeVerifier: verifier,
  })).rejects.toMatchObject({ code: 'invalid_grant' });
});

test('PKCE不一致、resource不一致、拒否はOAuth protocol errorになる', async () => {
  const { service } = await setup();
  const client = await service.registerPublicClient({
    clientName: 'Codex', redirectUris: [callback],
    grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], tokenEndpointAuthMethod: 'none',
  });
  await expect(service.beginAuthorization({ ...validRequest(client.client_id), resource: 'https://evil.example/api/mcp' }))
    .rejects.toMatchObject({ code: 'invalid_target' });

  const started = await service.beginAuthorization(validRequest(client.client_id));
  await expect(service.approveAuthorization({
    transactionId: started.transactionId, csrfToken: started.csrfToken, userId: 'user-1', approved: false,
  })).resolves.toMatchObject({ error: 'access_denied', state: 'state-1' });

  const second = await service.beginAuthorization(validRequest(client.client_id));
  const approved = await service.approveAuthorization({
    transactionId: second.transactionId, csrfToken: second.csrfToken, userId: 'user-1', approved: true,
  });
  await expect(service.exchangeAuthorizationCode({
    clientId: client.client_id, code: approved.code!, redirectUri: callback, codeVerifier: 'wrong-verifier',
  })).rejects.toMatchObject({ code: 'invalid_grant' });
});

test('refreshはresourceを継承し、旧token再利用時にfamilyを失効する', async () => {
  const { service } = await setup();
  const client = await service.registerPublicClient({
    clientName: 'Codex', redirectUris: [callback],
    grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], tokenEndpointAuthMethod: 'none',
  });
  const started = await service.beginAuthorization(validRequest(client.client_id));
  const approval = await service.approveAuthorization({
    transactionId: started.transactionId, csrfToken: started.csrfToken, userId: 'user-1', approved: true,
  });
  const first = await service.exchangeAuthorizationCode({
    clientId: client.client_id, code: approval.code!, redirectUri: callback, codeVerifier: verifier,
  });
  const rotated = await service.refreshAccessToken({ clientId: client.client_id, refreshToken: first.refreshToken });

  expect(rotated.accessToken).toMatch(/^ltm_oat_/);
  await expect(service.refreshAccessToken({ clientId: client.client_id, refreshToken: first.refreshToken }))
    .rejects.toMatchObject({ code: 'invalid_grant' });
  await expect(service.verifyAccessToken(rotated.accessToken)).rejects.toMatchObject({ code: 'invalid_token' });
});

test('DCR schemaは許可値を正規化し、未知・unsupported metadataを保存しない', () => {
  expect(DcrClientRegistrationSchema.parse({
    client_name: 'Codex', redirect_uris: [callback],
  })).toEqual({
    clientName: 'Codex', redirectUris: [callback], grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'], tokenEndpointAuthMethod: 'none',
  });
  for (const input of [
    { redirect_uris: [callback, callback] },
    { redirect_uris: [callback], grant_types: ['client_credentials'] },
    { redirect_uris: [callback], response_types: ['token'] },
    { redirect_uris: [callback], token_endpoint_auth_method: 'client_secret_post' },
    { redirect_uris: ['http://localhost/callback'] },
    { redirect_uris: [callback], unknown: 'discard-me' },
  ]) {
    expect(() => DcrClientRegistrationSchema.parse(input)).toThrow();
  }
});

test('unsupported DCR inputはinvalid_client_metadataになり、service errorにsecretを含めない', async () => {
  const { service } = await setup();
  await expect(service.registerPublicClient({
    clientName: null,
    redirectUris: [callback],
    grantTypes: ['client_credentials'] as never,
    responseTypes: ['code'],
    tokenEndpointAuthMethod: 'none',
  })).rejects.toMatchObject({ code: 'invalid_client_metadata' });
  try {
    throw new OAuthProtocolError('invalid_request', 'safe message');
  } catch (error) {
    expect((error as Error).message).not.toContain('ltm_oat_');
  }
});
