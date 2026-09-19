import { headers } from 'next/headers';

import {
  createSessionCookie,
  UnauthorizedFirebaseError,
  verifyFirebaseIdToken,
  verifyFirebaseSessionCookie,
  type FirebasePrincipal,
} from './firebase';

export const SESSION_COOKIE_NAME = 'ltm_session';
export const SESSION_COOKIE_MAX_AGE = 5 * 24 * 60 * 60;

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

function bearerValue(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export interface PrincipalOptions {
  allowBearer?: boolean;
}

export async function getFirebasePrincipal(request: Request, options: PrincipalOptions = {}): Promise<FirebasePrincipal | null> {
  const session = cookieValue(request.headers.get('cookie'), SESSION_COOKIE_NAME);
  if (session) {
    try {
      return await verifyFirebaseSessionCookie(session);
    } catch {
      // A stale cookie may coexist with a fresh explicit API bearer token.
    }
  }
  if (!options.allowBearer) return null;
  const bearer = bearerValue(request.headers.get('authorization'));
  if (!bearer) return null;
  try {
    return await verifyFirebaseIdToken(bearer);
  } catch {
    return null;
  }
}

export async function requireFirebasePrincipal(request: Request, options: PrincipalOptions = {}): Promise<FirebasePrincipal> {
  const principal = await getFirebasePrincipal(request, options);
  if (!principal) throw new UnauthorizedFirebaseError();
  return principal;
}

export async function getCurrentFirebasePrincipal(): Promise<FirebasePrincipal | null> {
  const requestHeaders = await headers();
  return getFirebasePrincipal(new Request('http://localhost/', { headers: new Headers(requestHeaders) }));
}

export async function requireCurrentFirebasePrincipal(): Promise<FirebasePrincipal> {
  const principal = await getCurrentFirebasePrincipal();
  if (!principal) throw new UnauthorizedFirebaseError();
  return principal;
}

export { createSessionCookie };
