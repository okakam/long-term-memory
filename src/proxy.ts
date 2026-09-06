import { clerkMiddleware } from '@clerk/nextjs/server';

import { authRequired } from '@/lib/auth/config';

const publicPaths = [/^\/sign-in(?:\/|$)/, /^\/sign-up(?:\/|$)/, /^\/_next(?:\/|$)/];

export default clerkMiddleware(async (auth, request) => {
  if (!authRequired()) return;
  if (request.nextUrl.pathname.startsWith('/api/mcp')) return;
  if (publicPaths.some((pattern) => pattern.test(request.nextUrl.pathname))) return;
  await auth.protect();
});

export const config = {
  matcher: ['/((?!.*\\..*).*)'],
};
