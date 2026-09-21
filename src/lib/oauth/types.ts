export const MCP_OAUTH_SCOPE = 'mcp:access' as const;

export type OAuthCredentialPrincipal = {
  userId: string;
  credentialId: string;
  credentialKind: 'oauth';
};

export type OAuthGrantType = 'authorization_code' | 'refresh_token';

export interface OAuthClient {
  id: string;
  client_id: string;
  client_name: string;
  redirect_uris: [string];
  grant_types: OAuthGrantType[];
  response_types: ['code'];
  token_endpoint_auth_method: 'none';
  created_at: string;
}

export interface OAuthAuthorizationTransaction {
  id: string;
  transaction_hash: string;
  transaction_prefix: string;
  client_id: string;
  redirect_uri: string;
  response_type: 'code';
  scope: typeof MCP_OAUTH_SCOPE;
  resource: string;
  state: string | null;
  code_challenge: string;
  code_challenge_method: 'S256';
  csrf_hash: string;
  user_id: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

export interface OAuthAuthorizationCode {
  id: string;
  code_hash: string;
  code_prefix: string;
  user_id: string;
  client_id: string;
  grant_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  scope: typeof MCP_OAUTH_SCOPE;
  resource: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

export interface OAuthAccessToken {
  id: string;
  token_hash: string;
  token_prefix: string;
  user_id: string;
  client_id: string;
  grant_id: string;
  scope: typeof MCP_OAUTH_SCOPE;
  resource: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
}

export interface OAuthRefreshToken {
  id: string;
  token_hash: string;
  token_prefix: string;
  family_id: string;
  user_id: string;
  client_id: string;
  grant_id: string;
  scope: typeof MCP_OAUTH_SCOPE;
  resource: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  replaced_at: string | null;
  revoked_at: string | null;
}

export interface OAuthGrantSummary {
  id: string;
  user_id: string;
  client_id: string;
  client_name: string;
  scope: typeof MCP_OAUTH_SCOPE;
  resource: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface OAuthTokenSet {
  grant: OAuthGrantSummary;
  accessToken: OAuthAccessToken;
  refreshToken: OAuthRefreshToken;
}

export type ConsumeAuthorizationCodeInput = {
  codeHash: string;
  clientId: string;
  redirectUri: string;
};

export type RotateRefreshTokenInput = {
  refreshTokenHash: string;
  clientId: string;
  resource: string | null;
  now: string;
  next: OAuthTokenSet;
};

export type OAuthRefreshTokenRotation = {
  grant: OAuthGrantSummary;
  tokenSet: OAuthTokenSet;
} | null;

export type OAuthRateLimitInput = {
  bucket: 'register' | 'authorize' | 'token' | 'revoke';
  keyHash: string;
  limit: number;
  windowSeconds: 600;
  now: string;
};
