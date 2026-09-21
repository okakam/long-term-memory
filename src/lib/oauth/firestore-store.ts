import { Timestamp } from 'firebase-admin/firestore';

import type { FirestoreDocument, FirestoreGateway, FirestoreTransaction } from '@/lib/storage/firestore-metadata';
import { hashOpaqueSecret } from './crypto';
import type { OAuthStoreLike } from './store';
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

type CredentialKind = 'access' | 'refresh' | 'code';

type CredentialIndex = {
  token_hash: string;
  credential_kind: CredentialKind;
  family_id: string | null;
  user_id: string;
  grant_id: string;
};

function path(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join('/');
}

function clientPath(clientId: string): string {
  return path('oauthClients', clientId);
}

function transactionPath(hash: string): string {
  return path('oauthAuthorizationTransactions', hash);
}

function codePath(hash: string): string {
  return path('oauthAuthorizationCodes', hash);
}

function accessPath(hash: string): string {
  return path('oauthAccessTokens', hash);
}

function refreshPath(hash: string): string {
  return path('oauthRefreshTokens', hash);
}

function grantPath(userId: string, grantId: string): string {
  return path('oauthGrants', userId, 'grants', grantId);
}

function credentialIndexCollection(grantId: string): string {
  return path('oauthGrantCredentials', grantId, 'tokens');
}

function credentialIndexPath(grantId: string, tokenHash: string): string {
  return path('oauthGrantCredentials', grantId, 'tokens', tokenHash);
}

function rateLimitPath(input: OAuthRateLimitInput, windowStart: number): string {
  return path('oauthRateLimits', input.bucket, input.keyHash, String(windowStart));
}

function asRecord(document: FirestoreDocument): Record<string, unknown> {
  const value = document.data();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid OAuth document: ${document.path}`);
  return value;
}

function asIso(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  throw new Error('OAuth timestamp is invalid');
}

function asNullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : asIso(value);
}

function clientRecord(document: FirestoreDocument): OAuthClient {
  const data = asRecord(document);
  return {
    id: String(data.id),
    client_id: String(data.client_id),
    client_name: String(data.client_name),
    redirect_uris: data.redirect_uris as [string],
    grant_types: data.grant_types as OAuthClient['grant_types'],
    response_types: data.response_types as ['code'],
    token_endpoint_auth_method: data.token_endpoint_auth_method as 'none',
    created_at: asIso(data.created_at),
  };
}

function transactionRecord(document: FirestoreDocument): OAuthAuthorizationTransaction {
  const data = asRecord(document);
  return {
    id: String(data.id),
    transaction_hash: String(data.transaction_hash),
    transaction_prefix: String(data.transaction_prefix),
    client_id: String(data.client_id),
    redirect_uri: String(data.redirect_uri),
    response_type: data.response_type as 'code',
    scope: data.scope as 'mcp:access',
    resource: String(data.resource),
    state: data.state === null || data.state === undefined ? null : String(data.state),
    code_challenge: String(data.code_challenge),
    code_challenge_method: data.code_challenge_method as 'S256',
    csrf_hash: String(data.csrf_hash),
    user_id: data.user_id === null || data.user_id === undefined ? null : String(data.user_id),
    created_at: asIso(data.created_at),
    expires_at: asIso(data.expires_at),
    consumed_at: asNullableIso(data.consumed_at),
    revoked_at: asNullableIso(data.revoked_at),
  };
}

function codeRecord(document: FirestoreDocument): OAuthAuthorizationCode {
  const data = asRecord(document);
  return {
    id: String(data.id),
    code_hash: String(data.code_hash),
    code_prefix: String(data.code_prefix),
    user_id: String(data.user_id),
    client_id: String(data.client_id),
    grant_id: String(data.grant_id),
    redirect_uri: String(data.redirect_uri),
    code_challenge: String(data.code_challenge),
    code_challenge_method: data.code_challenge_method as 'S256',
    scope: data.scope as 'mcp:access',
    resource: String(data.resource),
    created_at: asIso(data.created_at),
    expires_at: asIso(data.expires_at),
    consumed_at: asNullableIso(data.consumed_at),
    revoked_at: asNullableIso(data.revoked_at),
  };
}

function accessRecord(document: FirestoreDocument): OAuthAccessToken {
  const data = asRecord(document);
  return {
    id: String(data.id),
    token_hash: String(data.token_hash),
    token_prefix: String(data.token_prefix),
    user_id: String(data.user_id),
    client_id: String(data.client_id),
    grant_id: String(data.grant_id),
    scope: data.scope as 'mcp:access',
    resource: String(data.resource),
    created_at: asIso(data.created_at),
    last_used_at: asNullableIso(data.last_used_at),
    expires_at: asIso(data.expires_at),
    revoked_at: asNullableIso(data.revoked_at),
  };
}

function refreshRecord(document: FirestoreDocument): OAuthRefreshToken {
  const data = asRecord(document);
  return {
    id: String(data.id),
    token_hash: String(data.token_hash),
    token_prefix: String(data.token_prefix),
    family_id: String(data.family_id),
    user_id: String(data.user_id),
    client_id: String(data.client_id),
    grant_id: String(data.grant_id),
    scope: data.scope as 'mcp:access',
    resource: String(data.resource),
    created_at: asIso(data.created_at),
    expires_at: asIso(data.expires_at),
    last_used_at: asNullableIso(data.last_used_at),
    replaced_at: asNullableIso(data.replaced_at),
    revoked_at: asNullableIso(data.revoked_at),
  };
}

function grantRecord(document: FirestoreDocument): OAuthGrantSummary {
  const data = asRecord(document);
  return {
    id: String(data.id),
    user_id: String(data.user_id),
    client_id: String(data.client_id),
    client_name: String(data.client_name),
    scope: data.scope as 'mcp:access',
    resource: String(data.resource),
    created_at: asIso(data.created_at),
    last_used_at: asNullableIso(data.last_used_at),
    revoked_at: asNullableIso(data.revoked_at),
  };
}

function indexRecord(document: FirestoreDocument): CredentialIndex {
  const data = asRecord(document);
  return {
    token_hash: String(data.token_hash),
    credential_kind: data.credential_kind as CredentialKind,
    family_id: data.family_id === null || data.family_id === undefined ? null : String(data.family_id),
    user_id: String(data.user_id),
    grant_id: String(data.grant_id),
  };
}

function indexData(record: CredentialIndex): Record<string, unknown> {
  return { ...record };
}

function tokenIndex(record: OAuthAccessToken | OAuthRefreshToken | OAuthAuthorizationCode, kind: CredentialKind): CredentialIndex {
  return {
    token_hash: 'token_hash' in record ? record.token_hash : record.code_hash,
    credential_kind: kind,
    family_id: 'family_id' in record ? record.family_id : null,
    user_id: record.user_id,
    grant_id: record.grant_id,
  };
}

function timestampMillis(value: unknown): number {
  try {
    return Date.parse(asIso(value));
  } catch {
    return Number.NaN;
  }
}

function credentialPath(index: CredentialIndex): string {
  switch (index.credential_kind) {
    case 'access': return accessPath(index.token_hash);
    case 'refresh': return refreshPath(index.token_hash);
    case 'code': return codePath(index.token_hash);
  }
}

async function revokeIndexedCredentials(
  transaction: FirestoreTransaction,
  grantId: string,
  revokedAt: string,
  familyId?: string,
): Promise<CredentialIndex[]> {
  const documents = await transaction.list(credentialIndexCollection(grantId));
  const indexes = documents.filter((document) => document.exists).map(indexRecord)
    .filter((index) => familyId === undefined || index.credential_kind === 'code' || index.family_id === familyId);
  for (const index of indexes) {
    const targetPath = credentialPath(index);
    const target = await transaction.get(targetPath);
    if (!target.exists) continue;
    const data = asRecord(target);
    if (index.credential_kind === 'code' && (data.consumed_at !== null && data.consumed_at !== undefined)) continue;
    if (data.revoked_at !== null && data.revoked_at !== undefined) continue;
    await transaction.update(targetPath, { revoked_at: revokedAt });
  }
  return indexes;
}

export class FirestoreOAuthStore implements OAuthStoreLike {
  constructor(public readonly gateway: FirestoreGateway) {}

  async registerClient(client: OAuthClient): Promise<void> {
    await this.gateway.set(clientPath(client.client_id), { ...client });
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const document = await this.gateway.get(clientPath(clientId));
    return document.exists ? clientRecord(document) : null;
  }

  async createAuthorizationTransaction(value: OAuthAuthorizationTransaction): Promise<void> {
    await this.gateway.set(transactionPath(value.transaction_hash), { ...value });
  }

  async getAuthorizationTransaction(id: string): Promise<OAuthAuthorizationTransaction | null> {
    const hash = /^[a-f0-9]{64}$/.test(id) ? id : hashOpaqueSecret(id);
    const document = await this.gateway.get(transactionPath(hash));
    return document.exists ? transactionRecord(document) : null;
  }

  async consumeAuthorizationTransaction(input: { id: string; csrfHash: string; userId: string }): Promise<OAuthAuthorizationTransaction | null> {
    const hash = /^[a-f0-9]{64}$/.test(input.id) ? input.id : hashOpaqueSecret(input.id);
    const now = new Date().toISOString();
    return this.gateway.runTransaction(async (transaction) => {
      const document = await transaction.get(transactionPath(hash));
      if (!document.exists) return null;
      const record = transactionRecord(document);
      if (record.csrf_hash !== input.csrfHash || record.consumed_at || record.revoked_at || Date.parse(record.expires_at) <= Date.now()) return null;
      await transaction.update(document.path, { user_id: input.userId, consumed_at: now });
      return { ...record, user_id: input.userId, consumed_at: now };
    });
  }

  async createAuthorizationCode(value: OAuthAuthorizationCode): Promise<void> {
    await this.gateway.runTransaction(async (transaction) => {
      await transaction.set(codePath(value.code_hash), { ...value });
      await transaction.set(credentialIndexPath(value.grant_id, value.code_hash), indexData(tokenIndex(value, 'code')));
    });
  }

  async consumeAuthorizationCode(input: ConsumeAuthorizationCodeInput): Promise<OAuthAuthorizationCode | null> {
    const now = new Date().toISOString();
    return this.gateway.runTransaction(async (transaction) => {
      const document = await transaction.get(codePath(input.codeHash));
      if (!document.exists) return null;
      const record = codeRecord(document);
      if (record.client_id !== input.clientId || record.redirect_uri !== input.redirectUri || record.consumed_at || record.revoked_at
        || Date.parse(record.expires_at) <= Date.now()) return null;
      await transaction.update(document.path, { consumed_at: now });
      return { ...record, consumed_at: now };
    });
  }

  async createTokenSet(value: OAuthTokenSet): Promise<void> {
    await this.gateway.runTransaction(async (transaction) => {
      await transaction.set(grantPath(value.grant.user_id, value.grant.id), { ...value.grant });
      await transaction.set(accessPath(value.accessToken.token_hash), { ...value.accessToken });
      await transaction.set(refreshPath(value.refreshToken.token_hash), { ...value.refreshToken });
      await transaction.set(
        credentialIndexPath(value.grant.id, value.accessToken.token_hash),
        indexData(tokenIndex(value.accessToken, 'access')),
      );
      await transaction.set(
        credentialIndexPath(value.grant.id, value.refreshToken.token_hash),
        indexData(tokenIndex(value.refreshToken, 'refresh')),
      );
    });
  }

  async findAccessTokenByHash(hash: string): Promise<OAuthAccessToken | null> {
    const document = await this.gateway.get(accessPath(hash));
    return document.exists ? accessRecord(document) : null;
  }

  async findRefreshTokenByHash(hash: string): Promise<OAuthRefreshToken | null> {
    const document = await this.gateway.get(refreshPath(hash));
    return document.exists ? refreshRecord(document) : null;
  }

  async rotateRefreshToken(input: RotateRefreshTokenInput): Promise<OAuthRefreshTokenRotation> {
    return this.gateway.runTransaction(async (transaction) => {
      const document = await transaction.get(refreshPath(input.refreshTokenHash));
      if (!document.exists) return null;
      const current = refreshRecord(document);
      if (current.client_id !== input.clientId || current.revoked_at || current.replaced_at
        || Date.parse(current.expires_at) <= Date.parse(input.now)
        || (input.resource !== null && input.resource !== current.resource)) return null;

      await transaction.update(document.path, { replaced_at: input.now, revoked_at: input.now });
      await transaction.update(grantPath(current.user_id, current.grant_id), { last_used_at: input.now });
      await transaction.set(accessPath(input.next.accessToken.token_hash), { ...input.next.accessToken });
      await transaction.set(refreshPath(input.next.refreshToken.token_hash), { ...input.next.refreshToken });
      await transaction.set(
        credentialIndexPath(input.next.grant.id, input.next.accessToken.token_hash),
        indexData(tokenIndex(input.next.accessToken, 'access')),
      );
      await transaction.set(
        credentialIndexPath(input.next.grant.id, input.next.refreshToken.token_hash),
        indexData(tokenIndex(input.next.refreshToken, 'refresh')),
      );
      return { grant: input.next.grant, tokenSet: input.next };
    });
  }

  async revokeAccessTokenByHash(tokenHash: string, revokedAt: string): Promise<boolean> {
    const document = await this.gateway.get(accessPath(tokenHash));
    if (!document.exists) return false;
    const data = asRecord(document);
    if (data.revoked_at !== null && data.revoked_at !== undefined) return false;
    await this.gateway.update(document.path, { revoked_at: revokedAt });
    return true;
  }

  async revokeRefreshTokenFamilyByHash(tokenHash: string, revokedAt: string): Promise<boolean> {
    return this.gateway.runTransaction(async (transaction) => {
      const document = await transaction.get(refreshPath(tokenHash));
      if (!document.exists) return false;
      const current = refreshRecord(document);
      const indexes = await revokeIndexedCredentials(transaction, current.grant_id, revokedAt, current.family_id);
      await transaction.update(grantPath(current.user_id, current.grant_id), { revoked_at: revokedAt });
      return indexes.length > 0;
    });
  }

  async revokeByGrantId(grantId: string, revokedAt: string): Promise<void> {
    await this.gateway.runTransaction(async (transaction) => {
      const indexes = await revokeIndexedCredentials(transaction, grantId, revokedAt);
      const owner = indexes.find((index) => index.grant_id === grantId)?.user_id;
      if (owner) await transaction.update(grantPath(owner, grantId), { revoked_at: revokedAt });
    });
  }

  async listGrants(userId: string): Promise<OAuthGrantSummary[]> {
    return (await this.gateway.list(path('oauthGrants', userId, 'grants')))
      .filter((document) => document.exists)
      .map(grantRecord)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async revokeGrant(userId: string, grantId: string, revokedAt: string): Promise<boolean> {
    return this.gateway.runTransaction(async (transaction) => {
      const grant = await transaction.get(grantPath(userId, grantId));
      if (!grant.exists) return false;
      await revokeIndexedCredentials(transaction, grantId, revokedAt);
      await transaction.update(grant.path, { revoked_at: revokedAt });
      return true;
    });
  }

  async takeRateLimit(input: OAuthRateLimitInput): Promise<boolean> {
    const timestamp = Date.parse(input.now);
    if (Number.isNaN(timestamp)) throw new Error('rate limit now must be an ISO timestamp');
    const windowStart = Math.floor(timestamp / (input.windowSeconds * 1000)) * input.windowSeconds;
    const expiresAt = new Date((windowStart + input.windowSeconds) * 1000);
    return this.gateway.runTransaction(async (transaction) => {
      const targetPath = rateLimitPath(input, windowStart);
      const document = await transaction.get(targetPath);
      const current = document.exists ? asRecord(document) : null;
      const currentCount = typeof current?.count === 'number' ? current.count : 0;
      const currentExpiry = current ? timestampMillis(current.expires_at) : Number.NaN;
      if (!current || Number.isNaN(currentExpiry) || currentExpiry <= timestamp) {
        await transaction.set(targetPath, {
          bucket: input.bucket,
          key_hash: input.keyHash,
          window_start: windowStart,
          count: 1,
          expires_at: Timestamp.fromDate(expiresAt),
        });
        return true;
      }
      if (currentCount >= input.limit) return false;
      await transaction.update(targetPath, { count: currentCount + 1 });
      return true;
    });
  }
}
