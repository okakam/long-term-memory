import { OAuthProtocolError } from './service';
import { getOAuthConfiguration } from './config';

function headers(retryAfter: number | null = null): Headers {
  const value = new Headers({ 'cache-control': 'no-store', 'content-type': 'application/json' });
  if (retryAfter !== null) value.set('retry-after', String(retryAfter));
  return value;
}

export function oauthErrorResponse(error: unknown): Response {
  const protocolError = error instanceof OAuthProtocolError
    ? error
    : new OAuthProtocolError('invalid_request', 'OAuth request is invalid');
  return new Response(JSON.stringify({ error: protocolError.code, error_description: protocolError.message }), {
    status: protocolError.status,
    headers: headers(protocolError.retryAfter),
  });
}

export function oauthUnauthorizedResponse(metadataUrl: URL): Response {
  return new Response('authentication required', {
    status: 401,
    headers: new Headers({
      'cache-control': 'no-store',
      'www-authenticate': `Bearer resource_metadata="${metadataUrl.href}"`,
    }),
  });
}

export function oauthInsufficientScopeResponse(metadataUrl: URL, scope: string): Response {
  return new Response(JSON.stringify({ error: 'insufficient_scope', scope }), {
    status: 403,
    headers: new Headers({
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${metadataUrl.href}"`,
    }),
  });
}

export function authorizationServerMetadata(configuration: ReturnType<typeof getOAuthConfiguration>): Record<string, unknown> {
  const issuer = configuration.issuer.origin;
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp:access'],
  };
}
