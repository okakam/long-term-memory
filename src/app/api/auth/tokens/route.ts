import { z } from 'zod';

import { assertSameOrigin } from '@/lib/auth/access';
import { requireWebPrincipal } from '@/lib/auth/clerk';
import { createPat, listPats, revokePat } from '@/lib/auth/pat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateTokenInput = z.object({
  label: z.string().trim().min(1).max(100),
  expires_at: z.string().optional(),
});

function errorResponse(error: unknown): Response {
  const status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 400;
  const message = status === 401 ? 'authentication required' : status === 403 ? 'forbidden' : error instanceof Error ? error.message : 'request failed';
  return new Response(message, { status });
}

export async function GET(): Promise<Response> {
  try {
    const principal = await requireWebPrincipal();
    return Response.json(await listPats(principal.userId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const principal = await requireWebPrincipal();
    const input = CreateTokenInput.parse(await req.json());
    const created = await createPat(principal.userId, input.label, input.expires_at);
    return Response.json({ token: created.token, token_id: created.tokenId }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const principal = await requireWebPrincipal();
    const tokenId = new URL(req.url).searchParams.get('token_id');
    if (!tokenId) return new Response('token_id is required', { status: 400 });
    await revokePat(principal.userId, tokenId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
