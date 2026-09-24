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
  getUserByEmail?(email: string): Promise<{ uid: string; email?: string }>;
  getUser?(uid: string): Promise<{ uid: string; email?: string }>;
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

export class MemberLookupError extends Error {
  readonly status = 400;

  constructor() {
    super('member account was not found');
    this.name = 'MemberLookupError';
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

export async function findFirebaseUserIdByEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  if (!isAllowedEmailDomain(normalized)) throw new MemberLookupError();
  const find = adminAuth().getUserByEmail;
  if (!find) throw new MemberLookupError();
  try {
    const user = await find(normalized);
    if (!user.uid || !isAllowedEmailDomain(user.email ?? normalized)) throw new MemberLookupError();
    return user.uid;
  } catch (error) {
    if (error instanceof MemberLookupError) throw error;
    throw new MemberLookupError();
  }
}

/** Returns a display-only address for a member UID without making list APIs fail. */
export async function findFirebaseEmailByUserId(userId: string): Promise<string | null> {
  const find = adminAuth().getUser;
  if (!find) return null;
  try {
    const user = await find(userId);
    if (!user.uid || !isAllowedEmailDomain(user.email)) return null;
    return user.email.trim().toLowerCase();
  } catch {
    return null;
  }
}
