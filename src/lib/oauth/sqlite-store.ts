import type { IndexStore } from '@/lib/storage/contracts';
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

type ClientRow = Omit<OAuthClient, 'redirect_uris' | 'grant_types' | 'response_types'> & {
  redirect_uris: string;
  grant_types: string;
  response_types: string;
};

function json<T>(value: string): T {
  return JSON.parse(value) as T;
}

function transactionHash(id: string): string {
  return /^[a-f0-9]{64}$/.test(id) ? id : hashOpaqueSecret(id);
}

function clientRecord(row: ClientRow): OAuthClient {
  return {
    id: row.id,
    client_id: row.client_id,
    client_name: row.client_name,
    redirect_uris: json<[string]>(row.redirect_uris),
    grant_types: json<OAuthClient['grant_types']>(row.grant_types),
    response_types: json<['code']>(row.response_types),
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    created_at: row.created_at,
  };
}

function transactionRecord(row: OAuthAuthorizationTransaction): OAuthAuthorizationTransaction {
  return { ...row };
}

function insertTokenSet(tx: IndexStore, value: OAuthTokenSet): Promise<void> {
  return (async () => {
    await tx.exec(
      'INSERT INTO oauth_grants ' +
      '(id, user_id, client_id, client_name, scope, resource, created_at, last_used_at, revoked_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [value.grant.id, value.grant.user_id, value.grant.client_id, value.grant.client_name, value.grant.scope,
        value.grant.resource, value.grant.created_at, value.grant.last_used_at, value.grant.revoked_at],
    );
    await insertAccessToken(tx, value.accessToken);
    await insertRefreshToken(tx, value.refreshToken);
  })();
}

function insertAccessToken(tx: IndexStore, value: OAuthAccessToken): Promise<void> {
  return tx.exec(
    'INSERT INTO oauth_access_tokens ' +
    '(id, token_hash, token_prefix, user_id, client_id, grant_id, scope, resource, created_at, last_used_at, expires_at, revoked_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [value.id, value.token_hash, value.token_prefix, value.user_id, value.client_id, value.grant_id, value.scope,
      value.resource, value.created_at, value.last_used_at, value.expires_at, value.revoked_at],
  );
}

function insertRefreshToken(tx: IndexStore, value: OAuthRefreshToken): Promise<void> {
  return tx.exec(
    'INSERT INTO oauth_refresh_tokens ' +
    '(id, token_hash, token_prefix, family_id, user_id, client_id, grant_id, scope, resource, created_at, expires_at, last_used_at, replaced_at, revoked_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [value.id, value.token_hash, value.token_prefix, value.family_id, value.user_id, value.client_id, value.grant_id,
      value.scope, value.resource, value.created_at, value.expires_at, value.last_used_at, value.replaced_at, value.revoked_at],
  );
}

export class SqliteOAuthStore implements OAuthStoreLike {
  constructor(public readonly db: IndexStore) {}

  async registerClient(client: OAuthClient): Promise<void> {
    await this.db.exec(
      'INSERT INTO oauth_clients ' +
      '(client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
      [client.client_id, client.client_name, JSON.stringify(client.redirect_uris), JSON.stringify(client.grant_types),
        JSON.stringify(client.response_types), client.token_endpoint_auth_method, client.created_at],
    );
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const rows = await this.db.query<ClientRow>(
      'SELECT client_id, client_id AS id, client_name, redirect_uris, grant_types, response_types, ' +
      'token_endpoint_auth_method, created_at FROM oauth_clients WHERE client_id = ?',
      [clientId],
    );
    return rows[0] ? clientRecord(rows[0]) : null;
  }

  async createAuthorizationTransaction(value: OAuthAuthorizationTransaction): Promise<void> {
    await this.db.exec(
      'INSERT INTO oauth_authorization_transactions ' +
      '(id, transaction_hash, transaction_prefix, client_id, redirect_uri, response_type, scope, resource, state, ' +
      'code_challenge, code_challenge_method, csrf_hash, user_id, created_at, expires_at, consumed_at, revoked_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [value.id, value.transaction_hash, value.transaction_prefix, value.client_id, value.redirect_uri, value.response_type,
        value.scope, value.resource, value.state, value.code_challenge, value.code_challenge_method, value.csrf_hash,
        value.user_id, value.created_at, value.expires_at, value.consumed_at, value.revoked_at],
    );
  }

  async getAuthorizationTransaction(id: string): Promise<OAuthAuthorizationTransaction | null> {
    const rows = await this.db.query<OAuthAuthorizationTransaction>(
      'SELECT id, transaction_hash, transaction_prefix, client_id, redirect_uri, response_type, scope, resource, state, ' +
      'code_challenge, code_challenge_method, csrf_hash, user_id, created_at, expires_at, consumed_at, revoked_at ' +
      'FROM oauth_authorization_transactions WHERE transaction_hash = ?',
      [transactionHash(id)],
    );
    return rows[0] ? transactionRecord(rows[0]) : null;
  }

  async consumeAuthorizationTransaction(input: { id: string; csrfHash: string; userId: string }): Promise<OAuthAuthorizationTransaction | null> {
    const now = new Date().toISOString();
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<OAuthAuthorizationTransaction>(
        'SELECT id, transaction_hash, transaction_prefix, client_id, redirect_uri, response_type, scope, resource, state, ' +
        'code_challenge, code_challenge_method, csrf_hash, user_id, created_at, expires_at, consumed_at, revoked_at ' +
        'FROM oauth_authorization_transactions WHERE transaction_hash = ? AND csrf_hash = ? ' +
        'AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?',
        [transactionHash(input.id), input.csrfHash, now],
      );
      const record = rows[0];
      if (!record) return null;
      await tx.exec(
        'UPDATE oauth_authorization_transactions SET user_id = ?, consumed_at = ? WHERE transaction_hash = ?',
        [input.userId, now, record.transaction_hash],
      );
      return { ...record, user_id: input.userId, consumed_at: now };
    });
  }

  async createAuthorizationCode(value: OAuthAuthorizationCode): Promise<void> {
    await this.db.exec(
      'INSERT INTO oauth_authorization_codes ' +
      '(id, code_hash, code_prefix, user_id, client_id, grant_id, redirect_uri, code_challenge, code_challenge_method, ' +
      'scope, resource, created_at, expires_at, consumed_at, revoked_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [value.id, value.code_hash, value.code_prefix, value.user_id, value.client_id, value.grant_id, value.redirect_uri,
        value.code_challenge, value.code_challenge_method, value.scope, value.resource, value.created_at, value.expires_at,
        value.consumed_at, value.revoked_at],
    );
  }

  async consumeAuthorizationCode(input: ConsumeAuthorizationCodeInput): Promise<OAuthAuthorizationCode | null> {
    const now = new Date().toISOString();
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<OAuthAuthorizationCode>(
        'SELECT id, code_hash, code_prefix, user_id, client_id, grant_id, redirect_uri, code_challenge, code_challenge_method, ' +
        'scope, resource, created_at, expires_at, consumed_at, revoked_at FROM oauth_authorization_codes ' +
        'WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?',
        [input.codeHash, input.clientId, input.redirectUri, now],
      );
      const record = rows[0];
      if (!record) return null;
      await tx.exec('UPDATE oauth_authorization_codes SET consumed_at = ? WHERE code_hash = ?', [now, input.codeHash]);
      return { ...record, consumed_at: now };
    });
  }

  async createTokenSet(value: OAuthTokenSet): Promise<void> {
    await this.db.transaction((tx) => insertTokenSet(tx, value));
  }

  async findAccessTokenByHash(hash: string): Promise<OAuthAccessToken | null> {
    const rows = await this.db.query<OAuthAccessToken>('SELECT * FROM oauth_access_tokens WHERE token_hash = ?', [hash]);
    return rows[0] ?? null;
  }

  async findRefreshTokenByHash(hash: string): Promise<OAuthRefreshToken | null> {
    const rows = await this.db.query<OAuthRefreshToken>('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?', [hash]);
    return rows[0] ?? null;
  }

  async rotateRefreshToken(input: RotateRefreshTokenInput): Promise<OAuthRefreshTokenRotation> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<OAuthRefreshToken>('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?', [input.refreshTokenHash]);
      const current = rows[0];
      if (!current || current.client_id !== input.clientId || current.revoked_at || current.replaced_at
        || Date.parse(current.expires_at) <= Date.parse(input.now)
        || (input.resource !== null && input.resource !== current.resource)) return null;

      await tx.exec('UPDATE oauth_refresh_tokens SET replaced_at = ?, revoked_at = ? WHERE token_hash = ?',
        [input.now, input.now, input.refreshTokenHash]);
      await tx.exec('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?', [input.now, current.grant_id]);
      await insertAccessToken(tx, input.next.accessToken);
      await insertRefreshToken(tx, input.next.refreshToken);
      return { grant: input.next.grant, tokenSet: input.next };
    });
  }

  async revokeAccessTokenByHash(tokenHash: string, revokedAt: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      'SELECT id FROM oauth_access_tokens WHERE token_hash = ? AND revoked_at IS NULL', [tokenHash]);
    if (result.length === 0) return false;
    await this.db.exec('UPDATE oauth_access_tokens SET revoked_at = ? WHERE token_hash = ?', [revokedAt, tokenHash]);
    return true;
  }

  async revokeRefreshTokenFamilyByHash(tokenHash: string, revokedAt: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<OAuthRefreshToken>('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?', [tokenHash]);
      const current = rows[0];
      if (!current) return false;
      await tx.exec('UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL', [revokedAt, current.family_id]);
      await tx.exec('UPDATE oauth_access_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL', [revokedAt, current.grant_id]);
      await tx.exec('UPDATE oauth_authorization_codes SET revoked_at = ? WHERE grant_id = ? AND consumed_at IS NULL AND revoked_at IS NULL', [revokedAt, current.grant_id]);
      await tx.exec('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [revokedAt, current.grant_id]);
      return true;
    });
  }

  async revokeByGrantId(grantId: string, revokedAt: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.exec('UPDATE oauth_access_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL', [revokedAt, grantId]);
      await tx.exec('UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL', [revokedAt, grantId]);
      await tx.exec('UPDATE oauth_authorization_codes SET revoked_at = ? WHERE grant_id = ? AND consumed_at IS NULL AND revoked_at IS NULL', [revokedAt, grantId]);
      await tx.exec('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [revokedAt, grantId]);
    });
  }

  async listGrants(userId: string): Promise<OAuthGrantSummary[]> {
    return this.db.query<OAuthGrantSummary>('SELECT * FROM oauth_grants WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  }

  async revokeGrant(userId: string, grantId: string, revokedAt: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>('SELECT id FROM oauth_grants WHERE id = ? AND user_id = ?', [grantId, userId]);
    if (rows.length === 0) return false;
    await this.revokeByGrantId(grantId, revokedAt);
    return true;
  }

  async takeRateLimit(input: OAuthRateLimitInput): Promise<boolean> {
    const timestamp = Date.parse(input.now);
    if (Number.isNaN(timestamp)) throw new Error('rate limit now must be an ISO timestamp');
    const windowStart = Math.floor(timestamp / (input.windowSeconds * 1000)) * input.windowSeconds;
    const expiresAt = new Date((windowStart + input.windowSeconds) * 1000).toISOString();
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ count: number; expires_at: string }>(
        'SELECT count, expires_at FROM oauth_rate_limits WHERE bucket = ? AND key_hash = ? AND window_start = ?',
        [input.bucket, input.keyHash, windowStart],
      );
      const current = rows[0];
      if (!current || Date.parse(current.expires_at) <= timestamp) {
        await tx.exec(
          'INSERT OR REPLACE INTO oauth_rate_limits (bucket, key_hash, window_start, count, expires_at) VALUES (?, ?, ?, ?, ?)',
          [input.bucket, input.keyHash, windowStart, 1, expiresAt],
        );
        return true;
      }
      if (current.count >= input.limit) return false;
      await tx.exec(
        'UPDATE oauth_rate_limits SET count = count + 1 WHERE bucket = ? AND key_hash = ? AND window_start = ?',
        [input.bucket, input.keyHash, windowStart],
      );
      return true;
    });
  }

  close(): void | Promise<void> {
    return this.db.close?.();
  }
}
