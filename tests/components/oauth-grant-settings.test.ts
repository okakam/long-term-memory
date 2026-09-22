import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

import {
  OAuthGrantSettings,
  removeRevokedGrant,
  revokeOAuthGrant,
  type OAuthGrantSummary,
} from '@/components/OAuthGrantSettings';

const grant: OAuthGrantSummary = {
  id: 'grant-1', user_id: 'user-1', client_id: 'client-1', client_name: 'Codex',
  scope: 'mcp:access', resource: 'https://example.test/api/mcp',
  created_at: '2026-09-21T00:00:00.000Z', last_used_at: '2026-09-21T01:00:00.000Z', revoked_at: null,
};

test('OAuth grant設定はclient、scope、日時、失効操作を表示するがcredential本文を表示しない', () => {
  const markup = renderToStaticMarkup(createElement(OAuthGrantSettings, { initialGrants: [grant] }));
  expect(markup).toContain('Codex');
  expect(markup).toContain('mcp:access');
  expect(markup).toContain(grant.created_at);
  expect(markup).toContain(grant.last_used_at!);
  expect(markup).toContain('接続を失効');
  expect(markup).not.toContain('access_token');
  expect(markup).not.toContain('token_hash');
  expect(markup).not.toContain('family_id');
});

test('失効後一覧からgrantを除去し、APIにはDELETEだけを送る', async () => {
  const response = new Response(null, { status: 204 });
  const fetcher = vi.fn(async () => response);
  await revokeOAuthGrant(grant.id, fetcher);
  expect(fetcher).toHaveBeenCalledWith(`/api/auth/oauth-grants?grant_id=${grant.id}`, { method: 'DELETE' });
  expect(removeRevokedGrant([grant], grant.id)).toEqual([]);
});
