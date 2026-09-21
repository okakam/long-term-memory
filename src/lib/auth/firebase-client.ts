'use client';

import { getApps, initializeApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type Auth,
  type UserCredential,
} from 'firebase/auth';

import { ALLOWED_EMAIL_DOMAIN } from './email-domain';

interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

let configPromise: Promise<FirebaseClientConfig> | null = null;

function envConfig(): FirebaseClientConfig | null {
  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
  return Object.values(config).every((value): value is string => Boolean(value)) ? config as FirebaseClientConfig : null;
}

async function clientConfig(): Promise<FirebaseClientConfig> {
  const fromEnv = envConfig();
  if (fromEnv) return fromEnv;
  if (!configPromise) {
    configPromise = fetch('/api/auth/config', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Firebase認証設定を取得できません');
        const value = await response.json() as Partial<FirebaseClientConfig>;
        if (!value.apiKey || !value.authDomain || !value.projectId || !value.appId) {
          throw new Error('Firebase認証設定が不完全です');
        }
        return value as FirebaseClientConfig;
      });
  }
  return configPromise;
}

async function clientAuth(): Promise<Auth> {
  const config = await clientConfig();
  const app = getApps()[0] ?? initializeApp(config);
  return getAuth(app);
}

export async function signInWithPassword(email: string, password: string): Promise<UserCredential> {
  return signInWithEmailAndPassword(await clientAuth(), email, password);
}

export async function signUpWithPassword(email: string, password: string): Promise<UserCredential> {
  return createUserWithEmailAndPassword(await clientAuth(), email, password);
}

export function createGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: ALLOWED_EMAIL_DOMAIN });
  return provider;
}

export async function signInWithGoogle(): Promise<UserCredential> {
  return signInWithPopup(await clientAuth(), createGoogleProvider());
}

export async function establishSession(credential: UserCredential): Promise<void> {
  const auth = await clientAuth();
  const idToken = await credential.user.getIdToken();
  const response = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (response.ok) return;
  const message = await response.text();
  await signOut(auth).catch(() => undefined);
  throw new Error(message || 'authentication required');
}

export async function signOutFirebase(): Promise<void> {
  await signOut(await clientAuth());
  const response = await fetch('/api/auth/session', { method: 'DELETE' });
  if (!response.ok) throw new Error(await response.text());
}

export function subscribeFirebaseAuth(callback: (signedIn: boolean) => void): () => void {
  let active = true;
  let unsubscribe: () => void = () => undefined;
  void clientAuth()
    .then((auth) => {
      if (!active) return;
      unsubscribe = auth.onAuthStateChanged((user) => callback(Boolean(user)));
    })
    .catch(() => {
      if (active) callback(false);
    });
  return () => {
    active = false;
    unsubscribe();
  };
}
