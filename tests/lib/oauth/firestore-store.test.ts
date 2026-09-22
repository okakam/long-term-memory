import { afterEach, expect, test } from 'vitest';

import type { FirestoreDocument, FirestoreGateway, FirestoreTransaction } from '@/lib/storage/firestore-metadata';
import { FirestoreOAuthStore } from '@/lib/oauth/firestore-store';
import { hashOpaqueSecret } from '@/lib/oauth/crypto';
import type { OAuthAccessToken, OAuthClient, OAuthGrantSummary, OAuthRefreshToken, OAuthTokenSet } from '@/lib/oauth/types';

class FakeFirestore implements FirestoreGateway {
  readonly documents = new Map<string, Record<string, unknown>>();
  readonly getCalls: string[] = [];
  readonly listCalls: string[] = [];
  readonly transactionListCalls: string[] = [];

  async get(path: string): Promise<FirestoreDocument> {
    this.getCalls.push(path);
    return this.snapshot(path);
  }

  async list(collectionPath: string): Promise<FirestoreDocument[]> {
    this.listCalls.push(collectionPath);
    return this.listDocuments(collectionPath);
  }

  async set(path: string, data: Record<string, unknown>, merge = false): Promise<void> {
    const previous = this.documents.get(path);
    this.documents.set(path, merge && previous ? { ...previous, ...data } : { ...data });
  }

  async update(path: string, data: Record<string, unknown>): Promise<void> {
    if (!this.documents.has(path)) throw new Error(`missing document: ${path}`);
    await this.set(path, data, true);
  }

  async delete(path: string): Promise<void> {
    this.documents.delete(path);
  }

  async runTransaction<T>(fn: (transaction: FirestoreTransaction) => Promise<T>): Promise<T> {
    return fn({
      get: (path) => this.get(path),
      list: async (collectionPath) => {
        this.transactionListCalls.push(collectionPath);
        return this.listDocuments(collectionPath);
      },
      set: (path, data, merge) => this.set(path, data, merge),
      update: (path, data) => this.update(path, data),
      delete: (path) => this.delete(path),
    });
  }

  private listDocuments(collectionPath: string): FirestoreDocument[] {
    const prefix = `${collectionPath}/`;
    return [...this.documents.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map((path) => this.snapshot(path));
  }

  private snapshot(path: string): FirestoreDocument {
    return {
      id: path.split('/').at(-1)!,
      path,
      exists: this.documents.has(path),
      data: () => this.documents.get(path),
    };
  }
}

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

function tokenSet(): OAuthTokenSet {
  const grant: OAuthGrantSummary = {
    id: 'grant-1', user_id: 'user-1', client_id: 'client-1', client_name: 'Codex',
    scope: 'mcp:access', resource: 'https://ltm.okakam.net/api/mcp',
    created_at: '2026-09-21T00:00:00.000Z', last_used_at: null, revoked_at: null,
  };
  const accessToken: OAuthAccessToken = {
    id: 'access-1', token_hash: hashOpaqueSecret('access-secret'), token_prefix: 'ltm_oat_acce',
    user_id: 'user-1', client_id: 'client-1', grant_id: 'grant-1', scope: 'mcp:access', resource: grant.resource,
    created_at: grant.created_at, last_used_at: null, expires_at: '2026-09-21T00:15:00.000Z', revoked_at: null,
  };
  const refreshToken: OAuthRefreshToken = {
    id: 'refresh-1', token_hash: hashOpaqueSecret('refresh-secret'), token_prefix: 'ltm_ort_refr',
    family_id: 'family-1', user_id: 'user-1', client_id: 'client-1', grant_id: 'grant-1', scope: 'mcp:access', resource: grant.resource,
    created_at: grant.created_at, expires_at: '2026-10-21T00:00:00.000Z', last_used_at: null, replaced_at: null, revoked_at: null,
  };
  return { grant, accessToken, refreshToken };
}

const gateways: FakeFirestore[] = [];
afterEach(() => { gateways.splice(0); });

test('Firestore OAuth storeはhash document IDでO(1) lookupし、grant失効だけsubcollectionをtransaction内でlistする', async () => {
  const gateway = new FakeFirestore();
  gateways.push(gateway);
  const store = new FirestoreOAuthStore(gateway);
  await store.registerClient(client());
  const set = tokenSet();
  await store.createTokenSet(set);

  await expect(store.findAccessTokenByHash(set.accessToken.token_hash)).resolves.toMatchObject({ id: 'access-1' });
  await expect(store.findRefreshTokenByHash(set.refreshToken.token_hash)).resolves.toMatchObject({ family_id: 'family-1' });
  expect(gateway.listCalls).toEqual([]);
  expect(gateway.getCalls).toContain(`oauthAccessTokens/${set.accessToken.token_hash}`);
  expect(gateway.getCalls).toContain(`oauthRefreshTokens/${set.refreshToken.token_hash}`);

  await expect(store.revokeByGrantId('grant-1', '2026-09-21T00:04:00.000Z')).resolves.toBeUndefined();
  expect(gateway.transactionListCalls).toEqual(['oauthGrantCredentials/grant-1/tokens']);
  await expect(store.findAccessTokenByHash(set.accessToken.token_hash)).resolves.toMatchObject({ revoked_at: '2026-09-21T00:04:00.000Z' });
  await expect(store.findRefreshTokenByHash(set.refreshToken.token_hash)).resolves.toMatchObject({ revoked_at: '2026-09-21T00:04:00.000Z' });
});

test('Firestore OAuth storeのrate limitは期限切れcounterをwindow初回として扱う', async () => {
  const gateway = new FakeFirestore();
  gateways.push(gateway);
  const store = new FirestoreOAuthStore(gateway);
  const input = { bucket: 'register' as const, keyHash: 'global', limit: 1, windowSeconds: 600 as const, now: '2026-09-21T00:00:00.000Z' };

  await expect(store.takeRateLimit(input)).resolves.toBe(true);
  await expect(store.takeRateLimit(input)).resolves.toBe(false);
  await expect(store.takeRateLimit({ ...input, now: '2026-09-21T00:11:00.000Z' })).resolves.toBe(true);
});
