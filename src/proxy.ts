import { NextResponse, type NextRequest } from 'next/server';

import { authRequired } from '@/lib/auth/config';
import { getFirebasePrincipal } from '@/lib/auth/session';

const publicPaths = [
  /^\/sign-in(?:\/|$)/,
  /^\/sign-up(?:\/|$)/,
  /^\/api\/auth\/session$/,
  /^\/api\/auth\/config$/,
  /^\/api\/health$/,
  /^\/_next(?:\/|$)/,
];

export default async function proxy(request: NextRequest) {
  if (!authRequired() || request.nextUrl.pathname.startsWith('/api/mcp')
    || publicPaths.some((pattern) => pattern.test(request.nextUrl.pathname))) return NextResponse.next();
  if (await getFirebasePrincipal(request)) return NextResponse.next();
  const signIn = new URL('/sign-in', request.url);
  signIn.searchParams.set('redirect', request.nextUrl.pathname);
  return NextResponse.redirect(signIn);
}

export const config = {
  matcher: ['/((?!.*\\..*).*)'],
};
