import { z } from 'zod';

import { assertProjectAccess, assertSameOrigin, AuthorizationError } from '@/lib/auth/access';
import { findFirebaseEmailByUserId, findFirebaseUserIdByEmail } from '@/lib/auth/firebase';
import { requireWebPrincipal } from '@/lib/auth/web-principal';
import { getAuthStore } from '@/lib/auth/store';
import { assertProjectId } from '@/lib/slug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MemberInput = z.object({
  user_id: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: z.enum(['owner', 'member']).optional(),
}).refine((input) => Boolean(input.user_id) !== Boolean(input.email), 'email or user_id is required');
const RoleInput = z.object({ user_id: z.string().min(1), role: z.enum(['owner', 'member']) });

class MembershipConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'MembershipConflictError';
  }
}

async function projectId(params: Promise<{ id: string }>): Promise<string> {
  return assertProjectId((await params).id);
}

async function requireOwner(id: string, req: Request) {
  if (id === '__shared__') throw new AuthorizationError('shared scope has no members');
  const principal = await requireWebPrincipal(req);
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

async function requestedUserId(input: z.infer<typeof MemberInput>): Promise<string> {
  return input.user_id ?? findFirebaseUserIdByEmail(input.email!);
}

async function assertOwnerRemains(
  store: Awaited<ReturnType<typeof getAuthStore>>,
  projectId: string,
  userId: string,
): Promise<void> {
  const current = await store.getMembership(projectId, userId);
  if (current?.role !== 'owner') return;
  const owners = (await store.listMembers(projectId)).filter((member) => member.role === 'owner');
  if (owners.length <= 1) throw new MembershipConflictError('at least one owner is required');
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const id = await projectId(context.params);
    const principal = await requireWebPrincipal(req);
    const store = await getAuthStore();
    await assertProjectAccess(principal, id, 'read', store);
    const members = await store.listMembers(id);
    return Response.json(await Promise.all(members.map(async (member) => ({
      user_id: member.user_id,
      email: await findFirebaseEmailByUserId(member.user_id),
      role: member.role,
    }))));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const id = await projectId(context.params);
    const { store } = await requireOwner(id, req);
    const input = MemberInput.parse(await req.json());
    const userId = await requestedUserId(input);
    const role = input.role ?? 'member';
    const existing = await store.getMembership(id, userId);
    if (existing && existing.role !== role) throw new MembershipConflictError('member already has a different role');
    if (!existing) await store.addMember(id, userId, role);
    return Response.json({
      project_id: id,
      user_id: userId,
      email: await findFirebaseEmailByUserId(userId),
      role,
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    assertSameOrigin(req);
    const id = await projectId(context.params);
    const { store } = await requireOwner(id, req);
    const input = RoleInput.parse(await req.json());
    if (input.role !== 'owner') await assertOwnerRemains(store, id, input.user_id);
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
    const { store } = await requireOwner(id, req);
    const userId = new URL(req.url).searchParams.get('user_id');
    if (!userId) return new Response('user_id is required', { status: 400 });
    await assertOwnerRemains(store, id, userId);
    await store.removeMember(id, userId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
