import { afterEach, expect, test } from 'vitest';

import { requireWebPrincipal } from '@/lib/auth/web-principal';

afterEach(() => {
  delete process.env.AUTH_REQUIRED;
  delete process.env.LTM_LOCAL_USER_ID;
});

test('AUTH_REQUIRED=0ではlocal合成UIDで匿名開発用APIを利用できる', async () => {
  process.env.AUTH_REQUIRED = '0';
  process.env.LTM_LOCAL_USER_ID = 'local-developer';

  await expect(requireWebPrincipal()).resolves.toEqual({ userId: 'local-developer' });
});
