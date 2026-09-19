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

function requiredClientEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function firebaseClientConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY
    && process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
    && process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
    && process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  );
}

function clientAuth(): Auth {
  const config = {
    apiKey: requiredClientEnv('NEXT_PUBLIC_FIREBASE_API_KEY'),
    authDomain: requiredClientEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'),
    projectId: requiredClientEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID'),
    appId: requiredClientEnv('NEXT_PUBLIC_FIREBASE_APP_ID'),
  };
  const app = getApps()[0] ?? initializeApp(config);
  return getAuth(app);
}

export function signInWithPassword(email: string, password: string): Promise<UserCredential> {
  return signInWithEmailAndPassword(clientAuth(), email, password);
}

export function signUpWithPassword(email: string, password: string): Promise<UserCredential> {
  return createUserWithEmailAndPassword(clientAuth(), email, password);
}

export function signInWithGoogle(): Promise<UserCredential> {
  return signInWithPopup(clientAuth(), new GoogleAuthProvider());
}

export async function establishSession(credential: UserCredential): Promise<void> {
  const idToken = await credential.user.getIdToken();
  const response = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!response.ok) throw new Error(await response.text());
}

export async function signOutFirebase(): Promise<void> {
  await signOut(clientAuth());
  const response = await fetch('/api/auth/session', { method: 'DELETE' });
  if (!response.ok) throw new Error(await response.text());
}

export function subscribeFirebaseAuth(callback: (signedIn: boolean) => void): () => void {
  if (!firebaseClientConfigured()) {
    callback(false);
    return () => undefined;
  }
  return clientAuth().onAuthStateChanged((user) => callback(Boolean(user)));
}
