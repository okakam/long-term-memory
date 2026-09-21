import { z } from 'zod';

import {
  createSessionCookie,
  ForbiddenFirebaseError,
  verifyFirebaseIdToken,
} from '@/lib/auth/firebase';
import {
  SESSION_COOKIE_MAX_AGE,
  SESSION_COOKIE_NAME,
} from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SessionInput = z.object({ idToken: z.string().min(1) }).strict();

function cookie(value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Path=/${secure}`;
}

export async function POST(request: Request): Promise<Response> {
  if (new URL(request.url).search) return new Response('query parameters are not allowed', { status: 400 });
  let input: z.infer<typeof SessionInput>;
  try {
    input = SessionInput.parse(await request.json());
  } catch {
    return new Response('invalid request', { status: 400 });
  }
  try {
    await verifyFirebaseIdToken(input.idToken);
    const session = await createSessionCookie(input.idToken);
    return new Response(null, { status: 204, headers: { 'set-cookie': cookie(session, SESSION_COOKIE_MAX_AGE) } });
  } catch (cause) {
    if (cause instanceof ForbiddenFirebaseError) {
      return new Response(cause.message, { status: cause.status });
    }
    return new Response('authentication required', { status: 401 });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  if (new URL(request.url).search) return new Response('query parameters are not allowed', { status: 400 });
  return new Response(null, { status: 204, headers: { 'set-cookie': cookie('', 0) } });
}
