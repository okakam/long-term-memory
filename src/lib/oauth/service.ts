import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import { getOAuthConfiguration, getOAuthRateLimitKey, getOAuthRateLimitPolicy, type OAuthRateLimitBucket } from './config';
import { constantTimeEqual, hashOpaqueSecret, newOpaqueSecret, secretPrefix } from './crypto';
import { redirectUriMatches, validateDcrRedirectUri } from './redirect';
import { FirebaseOAuthIdentityProvider, type OAuthIdentityProvider } from './identity';
import { getOAuthStore, type OAuthStoreLike } from './store';
import { MCP_OAUTH_SCOPE, type OAuthAuthorizationCode, type OAuthClient, type OAuthCredentialPrincipal, type OAuthGrantSummary, type OAuthTokenSet } from './types';

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_client_metadata'
  | 'invalid_grant'
  | 'invalid_target'
  | 'invalid_token'
  | 'insufficient_scope'
  | 'temporarily_unavailable';

export class OAuthProtocolError extends Error {
  readonly status: number;
  readonly code: OAuthErrorCode;
  readonly retryAfter: number | null;

  constructor(code: OAuthErrorCode, message: string, options: { status?: number; retryAfter?: number } = {}) {
    super(message);
    this.name = 'OAuthProtocolError';
    this.code = code;
    this.status = options.status ?? (code === 'invalid_token' ? 401 : code === 'insufficient_scope' ? 403 : code === 'temporarily_unavailable' ? 429 : 400);
    this.retryAfter = options.retryAfter ?? null;
  }
}

export type OAuthAuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  responseType: 'code';
  scope: typeof MCP_OAUTH_SCOPE;
  resource: string;
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
};

export type OAuthAuthorizationStart = {
  transactionId: string;
  csrfToken: string;
  clientName: string;
  scope: typeof MCP_OAUTH_SCOPE;
};

export type OAuthAuthorizationApproval = {
  redirectUri: string;
  state: string | null;
  code?: string;
  error?: 'access_denied';
};

export type OAuthTokenResponse = {
  accessToken: string;
  refreshToken: string;
  expiresIn: 900;
  scope: typeof MCP_OAUTH_SCOPE;
};

export type DcrClientRegistrationInput = {
  clientName: string | null;
  redirectUris: [string];
  grantTypes: ['authorization_code', 'refresh_token'];
  responseTypes: ['code'];
  tokenEndpointAuthMethod: 'none';
};

const allowedGrantTypes = ['authorization_code', 'refresh_token'] as const;
const allowedResponseTypes = ['code'] as const;

export const DcrClientRegistrationSchema = z.object({
  client_name: z.string().trim().min(1).max(200).nullable().optional(),
  redirect_uris: z.array(z.string().min(1)).length(1),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
}).strict().superRefine((value, context) => {
  const grantTypes = value.grant_types ?? [...allowedGrantTypes];
  const responseTypes = value.response_types ?? [...allowedResponseTypes];
  const authMethod = value.token_endpoint_auth_method ?? 'none';
  if (grantTypes.length !== allowedGrantTypes.length || grantTypes.some((item, index) => item !== allowedGrantTypes[index])) {
    context.addIssue({ code: 'custom', path: ['grant_types'], message: 'invalid_client_metadata' });
  }
  if (responseTypes.length !== 1 || responseTypes[0] !== 'code') {
    context.addIssue({ code: 'custom', path: ['response_types'], message: 'invalid_client_metadata' });
  }
  if (authMethod !== 'none') {
    context.addIssue({ code: 'custom', path: ['token_endpoint_auth_method'], message: 'invalid_client_metadata' });
  }
  try {
    validateDcrRedirectUri(value.redirect_uris[0]);
  } catch {
    context.addIssue({ code: 'custom', path: ['redirect_uris'], message: 'invalid_client_metadata' });
  }
}).transform((value): DcrClientRegistrationInput => ({
  clientName: value.client_name ?? null,
  redirectUris: [value.redirect_uris[0]],
  grantTypes: ['authorization_code', 'refresh_token'],
  responseTypes: ['code'],
  tokenEndpointAuthMethod: 'none',
}));

type OAuthServiceOptions = {
  store?: OAuthStoreLike;
  identityProvider?: OAuthIdentityProvider;
  now?: () => Date;
  configuration?: ReturnType<typeof getOAuthConfiguration>;
};

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function expiresAt(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

function invalidRequest(message: string): OAuthProtocolError {
  return new OAuthProtocolError('invalid_request', message);
}

export class OAuthService {
  private readonly storeOverride?: OAuthStoreLike;
  readonly identityProvider: OAuthIdentityProvider;
  private readonly now: () => Date;
  private readonly configurationOverride?: ReturnType<typeof getOAuthConfiguration>;

  constructor(options: OAuthServiceOptions = {}) {
    this.storeOverride = options.store;
    this.identityProvider = options.identityProvider ?? new FirebaseOAuthIdentityProvider();
    this.now = options.now ?? (() => new Date());
    this.configurationOverride = options.configuration;
  }

  private configuration(): ReturnType<typeof getOAuthConfiguration> {
    return this.configurationOverride ?? getOAuthConfiguration();
  }

  private async store(): Promise<OAuthStoreLike> {
    return this.storeOverride ?? getOAuthStore();
  }

  private async rateLimit(bucket: OAuthRateLimitBucket, request: Request | undefined, clientId?: string): Promise<void> {
    const store = await this.store();
    const policy = getOAuthRateLimitPolicy(bucket);
    const requestForKey = request ?? new Request('https://localhost/');
    const key = getOAuthRateLimitKey(requestForKey, clientId);
    const take = async (keyHash: string, limit: number): Promise<boolean> => store.takeRateLimit({
      bucket, keyHash, limit, windowSeconds: 600, now: nowIso(this.now),
    });

    if (bucket === 'register') {
      if (!await take(hashOpaqueSecret('oauth:register:global'), policy.limit)) {
        throw new OAuthProtocolError('temporarily_unavailable', 'rate limit exceeded', { status: 429, retryAfter: 600 });
      }
      if (policy.secondaryLimit !== undefined && !await take(key.ipHash, policy.secondaryLimit)) {
        throw new OAuthProtocolError('temporarily_unavailable', 'rate limit exceeded', { status: 429, retryAfter: 600 });
      }
      return;
    }

    const scopedKey = bucket === 'token'
      ? hashOpaqueSecret(`${key.clientId ?? 'unknown'}:${key.ipHash}`)
      : key.ipHash;
    if (!await take(scopedKey, policy.limit)) {
      throw new OAuthProtocolError('temporarily_unavailable', 'rate limit exceeded', { status: 429, retryAfter: 600 });
    }
  }

  async registerPublicClient(input: DcrClientRegistrationInput, request?: Request): Promise<OAuthClient> {
    await this.rateLimit('register', request);
    if (input.clientName !== null && (!input.clientName.trim() || input.clientName.length > 200)) {
      throw new OAuthProtocolError('invalid_client_metadata', 'client metadata is invalid');
    }
    if (input.redirectUris.length !== 1 || input.grantTypes.join(',') !== allowedGrantTypes.join(',')
      || input.responseTypes.join(',') !== 'code' || input.tokenEndpointAuthMethod !== 'none') {
      throw new OAuthProtocolError('invalid_client_metadata', 'client metadata is invalid');
    }
    try {
      validateDcrRedirectUri(input.redirectUris[0]);
    } catch {
      throw new OAuthProtocolError('invalid_client_metadata', 'client metadata is invalid');
    }

    const clientId = newOpaqueSecret('ltm_cli_');
    const client: OAuthClient = {
      id: clientId,
      client_id: clientId,
      client_name: input.clientName?.trim() || 'MCP client',
      redirect_uris: [input.redirectUris[0]],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      created_at: nowIso(this.now),
    };
    await (await this.store()).registerClient(client);
    return client;
  }

  async beginAuthorization(input: OAuthAuthorizationRequest, request?: Request): Promise<OAuthAuthorizationStart> {
    const configuration = this.configuration();
    const store = await this.store();
    const client = await store.getClient(input.clientId);
    if (!client) throw new OAuthProtocolError('invalid_client', 'client is invalid');
    if (input.responseType !== 'code' || input.codeChallengeMethod !== 'S256' || input.scope !== MCP_OAUTH_SCOPE) {
      throw invalidRequest('authorization request is invalid');
    }
    if (!redirectUriMatches(client.redirect_uris[0], input.redirectUri)) {
      throw new OAuthProtocolError('invalid_request', 'redirect URI is invalid');
    }
    if (input.resource !== configuration.resource.href) {
      throw new OAuthProtocolError('invalid_target', 'resource is invalid');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
      throw invalidRequest('code challenge is invalid');
    }
    if (input.state !== null && input.state.length > 1024) throw invalidRequest('state is too long');
    await this.rateLimit('authorize', request);

    const transactionId = newOpaqueSecret('ltm_oatx_');
    const csrfToken = newOpaqueSecret('ltm_csrf_');
    const now = this.now();
    const transactionHash = hashOpaqueSecret(transactionId);
    await store.createAuthorizationTransaction({
      id: transactionHash,
      transaction_hash: transactionHash,
      transaction_prefix: secretPrefix(transactionId),
      client_id: client.client_id,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: MCP_OAUTH_SCOPE,
      resource: input.resource,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      csrf_hash: hashOpaqueSecret(csrfToken),
      user_id: null,
      created_at: now.toISOString(),
      expires_at: expiresAt(now, configuration.transactionTtlSeconds),
      consumed_at: null,
      revoked_at: null,
    });
    return { transactionId, csrfToken, clientName: client.client_name, scope: MCP_OAUTH_SCOPE };
  }

  async resumeAuthorization(transactionId: string, csrfToken: string): Promise<OAuthAuthorizationStart> {
    const store = await this.store();
    const transaction = await store.getAuthorizationTransaction(transactionId);
    if (!transaction || transaction.revoked_at || transaction.consumed_at || Date.parse(transaction.expires_at) <= this.now().getTime()
      || !constantTimeEqual(transaction.csrf_hash, hashOpaqueSecret(csrfToken))) {
      throw new OAuthProtocolError('invalid_grant', 'authorization transaction is invalid');
    }
    const client = await store.getClient(transaction.client_id);
    if (!client) throw new OAuthProtocolError('invalid_client', 'client is invalid');
    return { transactionId, csrfToken, clientName: client.client_name, scope: transaction.scope };
  }

  async approveAuthorization(input: { transactionId: string; csrfToken: string; userId: string; approved: boolean }): Promise<OAuthAuthorizationApproval> {
    const store = await this.store();
    const transaction = await store.consumeAuthorizationTransaction({
      id: input.transactionId,
      csrfHash: hashOpaqueSecret(input.csrfToken),
      userId: input.userId,
    });
    if (!transaction) throw new OAuthProtocolError('invalid_grant', 'authorization transaction is invalid');
    if (!input.approved) return { redirectUri: transaction.redirect_uri, state: transaction.state, error: 'access_denied' };

    const now = this.now();
    const code = newOpaqueSecret('ltm_oac_');
    const codeHash = hashOpaqueSecret(code);
    await store.createAuthorizationCode({
      id: randomUUID(),
      code_hash: codeHash,
      code_prefix: secretPrefix(code),
      user_id: input.userId,
      client_id: transaction.client_id,
      grant_id: randomUUID(),
      redirect_uri: transaction.redirect_uri,
      code_challenge: transaction.code_challenge,
      code_challenge_method: transaction.code_challenge_method,
      scope: transaction.scope,
      resource: transaction.resource,
      created_at: now.toISOString(),
      expires_at: expiresAt(now, this.configuration().authorizationCodeTtlSeconds),
      consumed_at: null,
      revoked_at: null,
    });
    return { redirectUri: transaction.redirect_uri, state: transaction.state, code };
  }

  async exchangeAuthorizationCode(input: { clientId: string; code: string; redirectUri: string; codeVerifier: string }, request?: Request): Promise<OAuthTokenResponse> {
    await this.rateLimit('token', request, input.clientId);
    if (input.codeVerifier.length < 43 || input.codeVerifier.length > 128) throw new OAuthProtocolError('invalid_grant', 'authorization code is invalid');
    const store = await this.store();
    const code = await store.consumeAuthorizationCode({
      codeHash: hashOpaqueSecret(input.code), clientId: input.clientId, redirectUri: input.redirectUri,
    });
    if (!code || !constantTimeEqual(pkceChallenge(input.codeVerifier), code.code_challenge)) {
      throw new OAuthProtocolError('invalid_grant', 'authorization code is invalid');
    }
    const configuration = this.configuration();
    if (code.resource !== configuration.resource.href || code.scope !== MCP_OAUTH_SCOPE) {
      throw new OAuthProtocolError('invalid_target', 'resource is invalid');
    }
    const client = await store.getClient(input.clientId);
    if (!client) throw new OAuthProtocolError('invalid_client', 'client is invalid');
    return this.issueTokenSet(store, {
      grantId: code.grant_id,
      userId: code.user_id,
      client,
      resource: code.resource,
      createdAt: this.now(),
    });
  }

  private async issueTokenSet(store: OAuthStoreLike, input: {
    grantId: string;
    userId: string;
    client: OAuthClient;
    resource: string;
    createdAt: Date;
    familyId?: string;
  }): Promise<OAuthTokenResponse> {
    const configuration = this.configuration();
    const accessToken = newOpaqueSecret('ltm_oat_');
    const refreshToken = newOpaqueSecret('ltm_ort_');
    const createdAt = input.createdAt.toISOString();
    const grant: OAuthGrantSummary = {
      id: input.grantId,
      user_id: input.userId,
      client_id: input.client.client_id,
      client_name: input.client.client_name,
      scope: MCP_OAUTH_SCOPE,
      resource: input.resource,
      created_at: createdAt,
      last_used_at: null,
      revoked_at: null,
    };
    const tokenSet: OAuthTokenSet = {
      grant,
      accessToken: {
        id: randomUUID(), token_hash: hashOpaqueSecret(accessToken), token_prefix: secretPrefix(accessToken),
        user_id: input.userId, client_id: input.client.client_id, grant_id: input.grantId,
        scope: MCP_OAUTH_SCOPE, resource: input.resource, created_at: createdAt, last_used_at: null,
        expires_at: expiresAt(input.createdAt, configuration.accessTokenTtlSeconds), revoked_at: null,
      },
      refreshToken: {
        id: randomUUID(), token_hash: hashOpaqueSecret(refreshToken), token_prefix: secretPrefix(refreshToken),
        family_id: input.familyId ?? randomUUID(), user_id: input.userId, client_id: input.client.client_id,
        grant_id: input.grantId, scope: MCP_OAUTH_SCOPE, resource: input.resource, created_at: createdAt,
        expires_at: expiresAt(input.createdAt, configuration.refreshTokenTtlSeconds), last_used_at: null,
        replaced_at: null, revoked_at: null,
      },
    };
    await store.createTokenSet(tokenSet);
    return { accessToken, refreshToken, expiresIn: 900, scope: MCP_OAUTH_SCOPE };
  }

  async refreshAccessToken(input: { clientId: string; refreshToken: string; resource?: string | null }, request?: Request): Promise<OAuthTokenResponse> {
    await this.rateLimit('token', request, input.clientId);
    const store = await this.store();
    const tokenHash = hashOpaqueSecret(input.refreshToken);
    const current = await store.findRefreshTokenByHash(tokenHash);
    if (!current || current.client_id !== input.clientId) throw new OAuthProtocolError('invalid_grant', 'refresh token is invalid');
    const requestedResource = input.resource ?? current.resource;
    if (requestedResource !== current.resource || requestedResource !== this.configuration().resource.href) {
      throw new OAuthProtocolError('invalid_target', 'resource is invalid');
    }
    const client = await store.getClient(input.clientId);
    if (!client) throw new OAuthProtocolError('invalid_client', 'client is invalid');
    const now = this.now();
    const nextAccessToken = newOpaqueSecret('ltm_oat_');
    const nextRefreshToken = newOpaqueSecret('ltm_ort_');
    const next = await this.makeTokenSet(current, client, now, nextAccessToken, nextRefreshToken);
    const rotation = await store.rotateRefreshToken({
      refreshTokenHash: tokenHash, clientId: input.clientId, resource: input.resource ?? null,
      now: now.toISOString(), next,
    });
    if (!rotation) {
      await store.revokeRefreshTokenFamilyByHash(tokenHash, now.toISOString());
      throw new OAuthProtocolError('invalid_grant', 'refresh token is invalid');
    }
    return { accessToken: nextAccessToken, refreshToken: nextRefreshToken, expiresIn: 900, scope: MCP_OAUTH_SCOPE };
  }

  private async makeTokenSet(current: { family_id: string; user_id: string; client_id: string; grant_id: string; scope: typeof MCP_OAUTH_SCOPE; resource: string }, client: OAuthClient, now: Date, access: string, refresh: string): Promise<OAuthTokenSet> {
    const config = this.configuration();
    const createdAt = now.toISOString();
    return {
      grant: {
        id: current.grant_id, user_id: current.user_id, client_id: current.client_id, client_name: client.client_name,
        scope: current.scope, resource: current.resource, created_at: createdAt, last_used_at: createdAt, revoked_at: null,
      },
      accessToken: {
        id: randomUUID(), token_hash: hashOpaqueSecret(access), token_prefix: secretPrefix(access), user_id: current.user_id,
        client_id: current.client_id, grant_id: current.grant_id, scope: current.scope, resource: current.resource,
        created_at: createdAt, last_used_at: null, expires_at: expiresAt(now, config.accessTokenTtlSeconds), revoked_at: null,
      },
      refreshToken: {
        id: randomUUID(), token_hash: hashOpaqueSecret(refresh), token_prefix: secretPrefix(refresh), family_id: current.family_id,
        user_id: current.user_id, client_id: current.client_id, grant_id: current.grant_id, scope: current.scope, resource: current.resource,
        created_at: createdAt, expires_at: expiresAt(now, config.refreshTokenTtlSeconds), last_used_at: null, replaced_at: null, revoked_at: null,
      },
    };
  }

  async verifyAccessToken(token: string): Promise<OAuthCredentialPrincipal> {
    const record = await (await this.store()).findAccessTokenByHash(hashOpaqueSecret(token));
    if (!record || record.revoked_at || Date.parse(record.expires_at) <= this.now().getTime()) {
      throw new OAuthProtocolError('invalid_token', 'access token is invalid');
    }
    const configuration = this.configuration();
    if (record.scope !== MCP_OAUTH_SCOPE || record.resource !== configuration.resource.href) {
      throw new OAuthProtocolError('insufficient_scope', 'mcp:access is required');
    }
    return { userId: record.user_id, credentialId: record.id, credentialKind: 'oauth' };
  }

  async revokeToken(token: string, request?: Request): Promise<void> {
    await this.rateLimit('revoke', request);
    const store = await this.store();
    const now = nowIso(this.now);
    if (await store.revokeAccessTokenByHash(hashOpaqueSecret(token), now)) return;
    await store.revokeRefreshTokenFamilyByHash(hashOpaqueSecret(token), now);
  }

  listGrants(userId: string): Promise<OAuthGrantSummary[]> {
    return this.store().then((store) => store.listGrants(userId));
  }

  revokeGrant(userId: string, grantId: string): Promise<boolean> {
    return this.store().then((store) => store.revokeGrant(userId, grantId, nowIso(this.now)));
  }
}
