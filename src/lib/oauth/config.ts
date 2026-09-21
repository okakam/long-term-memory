import { isIP } from 'node:net';

import { hashOpaqueSecret } from './crypto';

export type OAuthRateLimitBucket = 'register' | 'authorize' | 'token' | 'revoke';
export type OAuthRateLimitScope = 'global' | 'ip' | 'client-ip';

export type OAuthRateLimitPolicy = {
  windowSeconds: 600;
  limit: number;
  scope: OAuthRateLimitScope;
  secondaryLimit?: number;
};

const DEFAULT_PUBLIC_URL = 'http://localhost:3000';

function parseIssuer(raw: string, enabled: boolean): URL {
  let issuer: URL;
  try {
    issuer = new URL(raw);
  } catch {
    throw new Error('MCP_PUBLIC_URL must be a valid URL');
  }

  if (!['http:', 'https:'].includes(issuer.protocol) || !issuer.hostname) {
    throw new Error('MCP_PUBLIC_URL must use HTTP or HTTPS with a hostname');
  }
  if (issuer.search || issuer.hash) {
    throw new Error('MCP_PUBLIC_URL must not contain a query or fragment');
  }
  if (issuer.pathname !== '/' && issuer.pathname !== '') {
    throw new Error('MCP_PUBLIC_URL must not contain a path');
  }
  if (issuer.username || issuer.password || issuer.port) {
    throw new Error('MCP_PUBLIC_URL must not contain credentials or a port');
  }
  if (enabled && issuer.protocol !== 'https:') {
    throw new Error('MCP_PUBLIC_URL must use HTTPS when OAuth is enabled');
  }

  return new URL(issuer.origin);
}

export function getOAuthConfiguration(): {
  enabled: boolean;
  issuer: URL;
  resource: URL;
  metadataUrl: URL;
  accessTokenTtlSeconds: 900;
  refreshTokenTtlSeconds: 2_592_000;
  authorizationCodeTtlSeconds: 60;
  transactionTtlSeconds: 600;
} {
  const enabled = process.env.MCP_OAUTH_ENABLED === '1';
  if (enabled && process.env.AUTH_REQUIRED !== '1') {
    throw new Error('AUTH_REQUIRED=1 is required when MCP_OAUTH_ENABLED=1');
  }

  const issuer = parseIssuer(process.env.MCP_PUBLIC_URL ?? DEFAULT_PUBLIC_URL, enabled);

  return {
    enabled,
    issuer,
    resource: new URL('/api/mcp', issuer),
    metadataUrl: new URL('/.well-known/oauth-protected-resource/api/mcp', issuer),
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
    authorizationCodeTtlSeconds: 60,
    transactionTtlSeconds: 600,
  };
}

export function getOAuthRateLimitPolicy(bucket: OAuthRateLimitBucket): OAuthRateLimitPolicy {
  switch (bucket) {
    case 'register':
      return { windowSeconds: 600, limit: 30, scope: 'global', secondaryLimit: 5 };
    case 'authorize':
      return { windowSeconds: 600, limit: 20, scope: 'ip' };
    case 'token':
      return { windowSeconds: 600, limit: 60, scope: 'client-ip' };
    case 'revoke':
      return { windowSeconds: 600, limit: 30, scope: 'ip' };
  }
}

function forwardedIp(request: Request): string {
  const value = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  return isIP(value) ? value : 'unknown';
}

export function getOAuthRateLimitKey(request: Request, clientId?: string): { ipHash: string; clientId: string | null } {
  return {
    ipHash: hashOpaqueSecret(forwardedIp(request)),
    clientId: clientId?.trim() || null,
  };
}
