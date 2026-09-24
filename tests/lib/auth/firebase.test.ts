import { afterEach, expect, test, vi } from 'vitest';

import {
  findFirebaseUserIdByEmail,
  setFirebaseAuthForTests,
  verifyFirebaseIdToken,
  verifyFirebaseSessionCookie,
  type FirebaseAdminAuth,
} from '@/lib/auth/firebase';
import { getFirebasePrincipal, requireFirebasePrincipal } from '@/lib/auth/session';

const auth = {
  verifyIdToken: vi.fn(async (token: string) => {
    if (token !== 'id-token') throw new Error('invalid token');
    return { uid: 'firebase-user', email: 'user@okakam.net', email_verified: true };
  }),
  verifySessionCookie: vi.fn(async (cookie: string) => {
    if (cookie !== 'session-cookie') throw new Error('invalid cookie');
    return { uid: 'firebase-user', email: 'user@okakam.net', email_verified: true };
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
    email: 'user@okakam.net',
    emailVerified: true,
  });
  await expect(verifyFirebaseIdToken('bad-token')).rejects.toThrow('invalid token');
});

test('許可外メールのFirebase ID tokenをprincipalへ変換しない', async () => {
  setFirebaseAuthForTests({
    ...auth,
    verifyIdToken: vi.fn(async () => ({
      uid: 'external-user',
      email: 'user@example.com',
      email_verified: true,
    })),
  });

  await expect(verifyFirebaseIdToken('external-token')).rejects.toMatchObject({
    status: 403,
    message: 'email domain is not allowed',
  });
});

test('許可外メールのFirebase session cookieをprincipalへ変換しない', async () => {
  setFirebaseAuthForTests({
    ...auth,
    verifySessionCookie: vi.fn(async () => ({
      uid: 'external-user',
      email: 'user@example.com',
      email_verified: true,
    })),
  });

  await expect(verifyFirebaseSessionCookie('external-session')).rejects.toMatchObject({
    status: 403,
    message: 'email domain is not allowed',
  });
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

test('登録済みの許可emailだけをmember UIDへ解決する', async () => {
  setFirebaseAuthForTests({
    ...auth,
    getUserByEmail: vi.fn(async (email: string) => {
      if (email !== 'member@okakam.net') throw new Error('not found');
      return { uid: 'member-1', email };
    }),
  });

  await expect(findFirebaseUserIdByEmail(' MEMBER@OKAKAM.NET ')).resolves.toBe('member-1');
  await expect(findFirebaseUserIdByEmail('member@example.com')).rejects.toMatchObject({ status: 400 });
  await expect(findFirebaseUserIdByEmail('missing@okakam.net')).rejects.toMatchObject({ status: 400 });
});
