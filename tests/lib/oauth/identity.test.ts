import { afterEach, expect, test } from 'vitest';

import { setFirebaseAuthForTests } from '@/lib/auth/firebase';
import { FirebaseOAuthIdentityProvider } from '@/lib/oauth/identity';

afterEach(() => setFirebaseAuthForTests(null));

test('Firebase OAuth identityはsession cookieだけを使い、Bearer ID tokenを使わない', async () => {
  setFirebaseAuthForTests({
    verifySessionCookie: async (cookie) => ({ uid: 'user-1', email: `${cookie}@okakam.net` }),
    verifyIdToken: async () => ({ uid: 'bearer-user', email: 'bearer@okakam.net' }),
    createSessionCookie: async () => 'unused',
  });
  const provider = new FirebaseOAuthIdentityProvider();

  await expect(provider.getPrincipal(new Request('https://example.test/oauth/authorize', {
    headers: { authorization: 'Bearer firebase-id-token' },
  }))).resolves.toBeNull();
  await expect(provider.getPrincipal(new Request('https://example.test/oauth/authorize', {
    headers: { cookie: 'ltm_session=session-user' },
  }))).resolves.toEqual({ userId: 'user-1', email: 'session-user@okakam.net' });
});
