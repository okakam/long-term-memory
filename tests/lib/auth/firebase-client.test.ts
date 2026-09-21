import { afterEach, expect, test, vi } from 'vitest';

import type { UserCredential } from 'firebase/auth';

const mocks = vi.hoisted(() => {
  class FakeGoogleAuthProvider {
    private customParameters: Record<string, string> = {};

    setCustomParameters(parameters: Record<string, string>): this {
      this.customParameters = parameters;
      return this;
    }

    getCustomParameters(): Record<string, string> {
      return this.customParameters;
    }
  }

  return {
    auth: {},
    getApps: vi.fn(() => [{}]),
    initializeApp: vi.fn(() => ({})),
    getAuth: vi.fn(),
    signOut: vi.fn(async () => undefined),
    GoogleAuthProvider: FakeGoogleAuthProvider,
    createUserWithEmailAndPassword: vi.fn(),
    signInWithEmailAndPassword: vi.fn(),
    signInWithPopup: vi.fn(),
  };
});

vi.mock('firebase/app', () => ({
  getApps: mocks.getApps,
  initializeApp: mocks.initializeApp,
}));

vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: mocks.createUserWithEmailAndPassword,
  getAuth: mocks.getAuth,
  GoogleAuthProvider: mocks.GoogleAuthProvider,
  signInWithEmailAndPassword: mocks.signInWithEmailAndPassword,
  signInWithPopup: mocks.signInWithPopup,
  signOut: mocks.signOut,
}));

const { createGoogleProvider, establishSession } = await import('@/lib/auth/firebase-client');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.getAuth.mockReturnValue(mocks.auth);
});

test('Google providerはokakam.netをアカウント選択のヒントにする', () => {
  expect(createGoogleProvider().getCustomParameters()).toEqual({ hd: 'okakam.net' });
});

test('session交換に失敗したらFirebase client userをsign outする', async () => {
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', 'public-api-key');
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', 'example.firebaseapp.com');
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'firebase-project');
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_APP_ID', 'app-id');
  mocks.getAuth.mockReturnValue(mocks.auth);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('email domain is not allowed', { status: 403 })));

  const credential = {
    user: { getIdToken: vi.fn(async () => 'id-token') },
  } as unknown as UserCredential;

  await expect(establishSession(credential)).rejects.toThrow('email domain is not allowed');
  expect(mocks.signOut).toHaveBeenCalledWith(mocks.auth);
});
