import { afterEach, expect, test, vi } from 'vitest';

import { POST, DELETE } from '@/app/api/auth/session/route';
import { setFirebaseAuthForTests, type FirebaseAdminAuth } from '@/lib/auth/firebase';

const auth = {
  verifyIdToken: vi.fn(async (token: string) => {
    if (token !== 'id-token') throw new Error('invalid token');
    return { uid: 'firebase-user' };
  }),
  verifySessionCookie: vi.fn(async () => ({ uid: 'firebase-user' })),
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

test('DELETEでsession cookieを消去する', async () => {
  const response = await DELETE(new Request('https://example.test/api/auth/session', { method: 'DELETE' }));
  expect(response.status).toBe(204);
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
});
