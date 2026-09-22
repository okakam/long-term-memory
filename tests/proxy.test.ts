import { NextRequest } from 'next/server';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authRequired: vi.fn(() => true),
  getFirebasePrincipal: vi.fn(async () => null),
}));

vi.mock('@/lib/auth/config', () => ({ authRequired: mocks.authRequired }));
vi.mock('@/lib/auth/session', () => ({ getFirebasePrincipal: mocks.getFirebasePrincipal }));

import proxy from '@/proxy';

afterEach(() => {
  mocks.authRequired.mockReturnValue(true);
  mocks.getFirebasePrincipal.mockResolvedValue(null);
  vi.clearAllMocks();
});

test('OAuth protocol endpoints bypass the Firebase sign-in proxy', async () => {
  for (const pathname of ['/oauth/authorize', '/oauth/register', '/oauth/token', '/oauth/revoke']) {
    const response = await proxy(new NextRequest(`https://ltm.okakam.net${pathname}`, { method: 'POST' }));

    expect(response.status).toBe(200);
  }
  expect(mocks.getFirebasePrincipal).not.toHaveBeenCalled();
});
