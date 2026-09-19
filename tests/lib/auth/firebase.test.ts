import { afterEach, expect, test, vi } from 'vitest';

import {
  setFirebaseAuthForTests,
  verifyFirebaseIdToken,
  type FirebaseAdminAuth,
} from '@/lib/auth/firebase';
import { getFirebasePrincipal, requireFirebasePrincipal } from '@/lib/auth/session';

const auth = {
  verifyIdToken: vi.fn(async (token: string) => {
    if (token !== 'id-token') throw new Error('invalid token');
    return { uid: 'firebase-user', email: 'user@example.test', email_verified: true };
  }),
  verifySessionCookie: vi.fn(async (cookie: string) => {
    if (cookie !== 'session-cookie') throw new Error('invalid cookie');
    return { uid: 'firebase-user', email: 'user@example.test', email_verified: true };
  }),
  createSessionCookie: vi.fn(async (token: string) => {
    if (token !== 'id-token') throw new Error('invalid token');
    return 'session-cookie';
  }),
} satisfies FirebaseAdminAuth;

afterEach(() => {
  vi.clearAllMocks();
  setFirebaseAuthForTests(null);
});

test('Firebase ID tokenを検証してUID主体へ変換する', async () => {
  setFirebaseAuthForTests(auth);
  await expect(verifyFirebaseIdToken('id-token')).resolves.toEqual({
    userId: 'firebase-user',
    email: 'user@example.test',
    emailVerified: true,
  });
  await expect(verifyFirebaseIdToken('bad-token')).rejects.toThrow('invalid token');
});

test('session cookieを優先しBearerは明示許可時だけ検証する', async () => {
  setFirebaseAuthForTests(auth);
  const cookieRequest = new Request('https://example.test/', { headers: { cookie: 'ltm_session=session-cookie' } });
  await expect(getFirebasePrincipal(cookieRequest)).resolves.toMatchObject({ userId: 'firebase-user' });

  const bearerRequest = new Request('https://example.test/api/health', { headers: { authorization: 'Bearer id-token' } });
  await expect(getFirebasePrincipal(bearerRequest)).resolves.toBeNull();
  await expect(getFirebasePrincipal(bearerRequest, { allowBearer: true })).resolves.toMatchObject({ userId: 'firebase-user' });

  await expect(requireFirebasePrincipal(new Request('https://example.test/'))).rejects.toMatchObject({ status: 401 });
});
