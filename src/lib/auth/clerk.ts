import { auth } from '@clerk/nextjs/server';

import { authRequired } from './config';

export interface WebPrincipal {
  userId: string;
}

export class UnauthorizedWebError extends Error {
  readonly status = 401;
  constructor() {
    super('authentication required');
    this.name = 'UnauthorizedWebError';
  }
}

export async function getWebPrincipal(): Promise<WebPrincipal | null> {
  if (!authRequired()) return null;
  if (!process.env.CLERK_SECRET_KEY) return null;
  try {
    const session = await auth();
    return session.userId ? { userId: session.userId } : null;
  } catch {
    return null;
  }
}

export async function requireWebPrincipal(): Promise<WebPrincipal> {
  const principal = await getWebPrincipal();
  if (!principal) throw new UnauthorizedWebError();
  return principal;
}
