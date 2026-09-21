import { resolveStorageMode } from '@/lib/storage/contracts';
import { openAuthDb } from '@/lib/auth/connection';
import { createFirestoreGateway } from '@/lib/storage/firestore-metadata';
import { FirestoreOAuthStore } from './firestore-store';
import { SqliteOAuthStore } from './sqlite-store';
import type {
  ConsumeAuthorizationCodeInput,
  OAuthAccessToken,
  OAuthAuthorizationCode,
  OAuthAuthorizationTransaction,
  OAuthClient,
  OAuthGrantSummary,
  OAuthRateLimitInput,
  OAuthRefreshToken,
  OAuthRefreshTokenRotation,
  OAuthTokenSet,
  RotateRefreshTokenInput,
} from './types';

export interface OAuthStoreLike {
  registerClient(client: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | null>;
  createAuthorizationTransaction(value: OAuthAuthorizationTransaction): Promise<void>;
  getAuthorizationTransaction(id: string): Promise<OAuthAuthorizationTransaction | null>;
  consumeAuthorizationTransaction(input: { id: string; csrfHash: string; userId: string }): Promise<OAuthAuthorizationTransaction | null>;
  createAuthorizationCode(value: OAuthAuthorizationCode): Promise<void>;
  consumeAuthorizationCode(input: ConsumeAuthorizationCodeInput): Promise<OAuthAuthorizationCode | null>;
  createTokenSet(value: OAuthTokenSet): Promise<void>;
  findAccessTokenByHash(hash: string): Promise<OAuthAccessToken | null>;
  findRefreshTokenByHash(hash: string): Promise<OAuthRefreshToken | null>;
  rotateRefreshToken(input: RotateRefreshTokenInput): Promise<OAuthRefreshTokenRotation>;
  revokeAccessTokenByHash(tokenHash: string, revokedAt: string): Promise<boolean>;
  revokeRefreshTokenFamilyByHash(tokenHash: string, revokedAt: string): Promise<boolean>;
  revokeByGrantId(grantId: string, revokedAt: string): Promise<void>;
  listGrants(userId: string): Promise<OAuthGrantSummary[]>;
  revokeGrant(userId: string, grantId: string, revokedAt: string): Promise<boolean>;
  takeRateLimit(input: OAuthRateLimitInput): Promise<boolean>;
  close?(): void | Promise<void>;
}

let storePromise: Promise<OAuthStoreLike> | null = null;
let testStore: OAuthStoreLike | null = null;

export async function getOAuthStore(): Promise<OAuthStoreLike> {
  if (testStore) return testStore;
  if (!storePromise) {
    if (resolveStorageMode() === 'cloud') {
      storePromise = Promise.resolve(new FirestoreOAuthStore(createFirestoreGateway()));
    } else {
      storePromise = openAuthDb().then((db) => new SqliteOAuthStore(db));
    }
  }
  return storePromise;
}

export function setOAuthStoreForTests(store: OAuthStoreLike): void {
  testStore = store;
  storePromise = Promise.resolve(store);
}

export async function resetOAuthStoreForTests(): Promise<void> {
  const current = testStore ?? (storePromise ? await storePromise.catch(() => null) : null);
  testStore = null;
  storePromise = null;
  if (current) await current.close?.();
}
