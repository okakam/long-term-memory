import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

import { isAllowedEmailDomain } from './email-domain';

export interface FirebaseDecodedToken {
  uid: string;
  email?: string;
  email_verified?: boolean;
  [claim: string]: unknown;
}

export interface FirebaseAdminAuth {
  verifyIdToken(token: string): Promise<FirebaseDecodedToken>;
  verifySessionCookie(cookie: string): Promise<FirebaseDecodedToken>;
  createSessionCookie(idToken: string, options: { expiresIn: number }): Promise<string>;
}

export interface FirebasePrincipal {
  userId: string;
  email?: string;
  emailVerified?: boolean;
}

export class UnauthorizedFirebaseError extends Error {
  readonly status = 401;

  constructor() {
    super('authentication required');
    this.name = 'UnauthorizedFirebaseError';
  }
}

export class ForbiddenFirebaseError extends Error {
  readonly status = 403;

  constructor() {
    super('email domain is not allowed');
    this.name = 'ForbiddenFirebaseError';
  }
}

let testAuth: FirebaseAdminAuth | null = null;

export function getFirebaseAdminApp() {
  return getApps()[0] ?? initializeApp({
    credential: applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

function adminAuth(): FirebaseAdminAuth {
  if (testAuth) return testAuth;
  return getAuth(getFirebaseAdminApp()) as unknown as FirebaseAdminAuth;
}

function principal(decoded: FirebaseDecodedToken): FirebasePrincipal {
  if (!decoded.uid) throw new UnauthorizedFirebaseError();
  if (!isAllowedEmailDomain(decoded.email)) throw new ForbiddenFirebaseError();
  return {
    userId: decoded.uid,
    email: decoded.email,
    emailVerified: decoded.email_verified,
  };
}

export function setFirebaseAuthForTests(auth: FirebaseAdminAuth | null): void {
  testAuth = auth;
}

export async function verifyFirebaseIdToken(token: string): Promise<FirebasePrincipal> {
  return principal(await adminAuth().verifyIdToken(token));
}

export async function verifyFirebaseSessionCookie(cookie: string): Promise<FirebasePrincipal> {
  return principal(await adminAuth().verifySessionCookie(cookie));
}

export async function createSessionCookie(idToken: string): Promise<string> {
  return adminAuth().createSessionCookie(idToken, { expiresIn: 5 * 24 * 60 * 60 * 1000 });
}
