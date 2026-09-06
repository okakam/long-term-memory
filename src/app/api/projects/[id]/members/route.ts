import { z } from 'zod';

import { assertProjectAccess, assertSameOrigin, AuthorizationError } from '@/lib/auth/access';
import { requireWebPrincipal } from '@/lib/auth/clerk';
import { getAuthStore } from '@/lib/auth/store';
import { assertProjectId } from '@/lib/slug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MemberInput = z.object({
  user_id: z.string().min(1),
  role: z.enum(['owner', 'member']).optional(),
});
const RoleInput = z.object({ user_id: z.string().min(1), role: z.enum(['owner', 'member']) });

async function projectId(params: Promise<{ id: string }>): Promise<string> {
  return assertProjectId((await params).id);
}

async function requireOwner(id: string) {
  if (id === '__shared__') throw new AuthorizationError('shared scope has no members');
  const principal = await requireWebPrincipal();
  const store = await getAuthStore();
  await assertProjectAccess(principal, id, 'write', store);
  const membership = await store.getMembership(id, principal.userId);
  if (membership?.role !== 'owner') throw new AuthorizationError();
  return { principal, store };
}

function errorResponse(error: unknown): Response {
  const status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 400;
  const message = status === 401 ? 'authentication required' : status === 403 ? 'project access denied' : error instanceof Error ? error.message : 'request failed';
  return new Response(message, { status });
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const id = await projectId(context.params);
    const principal = await requireWebPrincipal();
    const store = await getAuthStore();
    await assertProjectAccess(principal, id, 'read', store);
    return Response.json(await store.listMembers(id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const id = await projectId(context.params);
    const { store } = await requireOwner(id);
    const input = MemberInput.parse(await req.json());
    await store.addMember(id, input.user_id, input.role ?? 'member');
    return Response.json({ project_id: id, user_id: input.user_id, role: input.role ?? 'member' }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const id = await projectId(context.params);
    const { store } = await requireOwner(id);
    const input = RoleInput.parse(await req.json());
    await store.setMemberRole(id, input.user_id, input.role);
    return Response.json({ project_id: id, user_id: input.user_id, role: input.role });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const id = await projectId(context.params);
    const { store } = await requireOwner(id);
    const userId = new URL(req.url).searchParams.get('user_id');
    if (!userId) return new Response('user_id is required', { status: 400 });
    await store.removeMember(id, userId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
