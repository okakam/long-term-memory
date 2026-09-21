import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireWebPrincipal: vi.fn(async () => ({ userId: 'user-1' })),
  listGrants: vi.fn(async () => [{
    id: 'grant-1', user_id: 'user-1', client_id: 'client-1', client_name: 'Codex',
    scope: 'mcp:access', resource: 'https://example.test/api/mcp',
    created_at: '2026-09-21T00:00:00.000Z', last_used_at: null, revoked_at: null,
  }]),
  revokeGrant: vi.fn(async () => true),
  OAuthService: vi.fn(function OAuthServiceMock() {
    return { listGrants: mocks.listGrants, revokeGrant: mocks.revokeGrant };
  }),
}));

vi.mock('@/lib/auth/web-principal', () => ({ requireWebPrincipal: mocks.requireWebPrincipal }));
vi.mock('@/lib/oauth/service', () => ({
  OAuthService: mocks.OAuthService,
}));

import { DELETE, GET } from '@/app/api/auth/oauth-grants/route';

afterEach(() => vi.clearAllMocks());

test('OAuth grant一覧は本人の接続だけを返し、同一originのDELETEだけを受け付ける', async () => {
  const listed = await GET(new Request('https://example.test/api/auth/oauth-grants'));
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual([expect.objectContaining({ id: 'grant-1', client_name: 'Codex' })]);
  expect(mocks.listGrants).toHaveBeenCalledWith('user-1');

  const foreignOrigin = await DELETE(new Request('https://example.test/api/auth/oauth-grants?grant_id=grant-1', {
    method: 'DELETE', headers: { origin: 'https://evil.example', host: 'example.test' },
  }));
  expect(foreignOrigin.status).toBe(403);
  expect(mocks.revokeGrant).not.toHaveBeenCalled();

  const revoked = await DELETE(new Request('https://example.test/api/auth/oauth-grants?grant_id=00000000-0000-4000-8000-000000000001', {
    method: 'DELETE', headers: { origin: 'https://example.test', host: 'example.test' },
  }));
  expect(revoked.status).toBe(204);
  expect(mocks.revokeGrant).toHaveBeenCalledWith('user-1', '00000000-0000-4000-8000-000000000001');
});

test('不正なgrant idは失効処理へ渡さない', async () => {
  const response = await DELETE(new Request('https://example.test/api/auth/oauth-grants?grant_id=not-a-uuid', {
    method: 'DELETE', headers: { origin: 'https://example.test', host: 'example.test' },
  }));
  expect(response.status).toBe(400);
  expect(mocks.revokeGrant).not.toHaveBeenCalled();
});
