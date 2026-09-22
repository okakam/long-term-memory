import { expect, test } from 'vitest';

import { oauthErrorResponse, oauthInsufficientScopeResponse, oauthUnauthorizedResponse } from '@/lib/oauth/http';
import { OAuthProtocolError } from '@/lib/oauth/service';

test('OAuth HTTP helperはno-store challengeと標準errorだけを返す', async () => {
  const metadata = new URL('https://ltm.okakam.net/.well-known/oauth-protected-resource/api/mcp');
  const unauthorized = oauthUnauthorizedResponse(metadata);
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get('cache-control')).toBe('no-store');
  expect(unauthorized.headers.get('www-authenticate')).toContain('resource_metadata=');

  const insufficient = oauthInsufficientScopeResponse(metadata, 'mcp:access');
  expect(insufficient.status).toBe(403);
  expect(insufficient.headers.get('www-authenticate')).toContain('insufficient_scope');

  const error = oauthErrorResponse(new OAuthProtocolError('invalid_grant', 'authorization code is invalid'));
  expect(error.status).toBe(400);
  expect(error.headers.get('cache-control')).toBe('no-store');
  await expect(error.json()).resolves.toEqual({ error: 'invalid_grant', error_description: 'authorization code is invalid' });
});
