import { z } from 'zod';

import { assertSameOrigin } from '@/lib/auth/access';
import { requireWebPrincipal } from '@/lib/auth/web-principal';
import { OAuthService } from '@/lib/oauth/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GrantId = z.string().uuid();

function errorResponse(error: unknown): Response {
  const status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 400;
  const message = status === 401 ? 'authentication required' : status === 403 ? 'forbidden' : error instanceof Error ? error.message : 'request failed';
  return new Response(message, { status, headers: { 'cache-control': 'no-store' } });
}

export async function GET(request?: Request): Promise<Response> {
  try {
    const principal = await requireWebPrincipal(request);
    const grants = await new OAuthService().listGrants(principal.userId);
    return Response.json(grants, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const principal = await requireWebPrincipal(request);
    const grantId = new URL(request.url).searchParams.get('grant_id');
    const parsed = GrantId.safeParse(grantId);
    if (!parsed.success) return new Response('grant_id is invalid', { status: 400, headers: { 'cache-control': 'no-store' } });
    await new OAuthService().revokeGrant(principal.userId, parsed.data);
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
