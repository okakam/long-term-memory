import { afterEach, expect, test, vi } from 'vitest';

import { GET as GETConfig } from '@/app/api/auth/config/route';
import { POST, DELETE } from '@/app/api/auth/session/route';
import { setFirebaseAuthForTests, type FirebaseAdminAuth } from '@/lib/auth/firebase';

const auth = {
  verifyIdToken: vi.fn(async (token: string) => {
    if (token !== 'id-token') throw new Error('invalid token');
    return { uid: 'firebase-user', email: 'user@okakam.net', email_verified: true };
  }),
  verifySessionCookie: vi.fn(async () => ({ uid: 'firebase-user', email: 'user@okakam.net', email_verified: true })),
  createSessionCookie: vi.fn(async () => 'session-cookie'),
} satisfies FirebaseAdminAuth;

afterEach(() => {
  vi.clearAllMocks();
  setFirebaseAuthForTests(null);
});

test('session endpointはID tokenからHttpOnly session cookieを発行する', async () => {
  setFirebaseAuthForTests(auth);
  const response = await POST(new Request('https://example.test/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: 'id-token' }),
  }));

  expect(response.status).toBe(204);
  expect(response.headers.get('set-cookie')).toContain('ltm_session=session-cookie');
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
  expect(response.headers.get('set-cookie')).toContain('Path=/');
});

test('session endpointはqueryと不正tokenを受け付けない', async () => {
  setFirebaseAuthForTests(auth);
  const queryResponse = await POST(new Request('https://example.test/api/auth/session?next=/admin', {
    method: 'POST',
    body: JSON.stringify({ idToken: 'id-token' }),
  }));
  expect(queryResponse.status).toBe(400);

  const invalidResponse = await POST(new Request('https://example.test/api/auth/session', {
    method: 'POST',
    body: JSON.stringify({ idToken: 'bad-token' }),
  }));
  expect(invalidResponse.status).toBe(401);
});

test('session endpointは許可外メールへcookieを発行しない', async () => {
  const createSessionCookie = vi.fn(async () => 'must-not-be-issued');
  setFirebaseAuthForTests({
    ...auth,
    verifyIdToken: vi.fn(async () => ({ uid: 'external-user', email: 'user@example.com' })),
    createSessionCookie,
  });

  const response = await POST(new Request('https://example.test/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: 'external-token' }),
  }));

  expect(response.status).toBe(403);
  expect(await response.text()).toBe('email domain is not allowed');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(createSessionCookie).not.toHaveBeenCalled();
});

test('DELETEでsession cookieを消去する', async () => {
  const response = await DELETE(new Request('https://example.test/api/auth/session', { method: 'DELETE' }));
  expect(response.status).toBe(204);
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
});

test('Firebase client config endpointは公開設定だけをno-storeで返す', async () => {
  const keys = [
    'NEXT_PUBLIC_FIREBASE_API_KEY',
    'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    'NEXT_PUBLIC_FIREBASE_APP_ID',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'public-api-key';
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = 'example.firebaseapp.com';
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'firebase-project';
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID = 'app-id';
    const response = await GETConfig(new Request('https://example.test/api/auth/config'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    await expect(response.json()).resolves.toEqual({
      apiKey: 'public-api-key',
      authDomain: 'example.firebaseapp.com',
      projectId: 'firebase-project',
      appId: 'app-id',
    });
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
