import { z } from 'zod';

import { assertSameOrigin, AuthorizationError } from '@/lib/auth/access';
import { requireWebPrincipal } from '@/lib/auth/clerk';
import { getAuthStore } from '@/lib/auth/store';
import { assertMemoryName } from '@/lib/slug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateProjectInput = z.object({
  project_id: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
}).refine((input) => input.project_id || input.slug, 'project_id or slug is required');

function errorResponse(error: unknown): Response {
  const status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 400;
  const message = status === 401 ? 'authentication required' : status === 403 ? 'project access denied' : error instanceof Error ? error.message : 'request failed';
  return new Response(message, { status });
}

export async function GET(): Promise<Response> {
  try {
    const principal = await requireWebPrincipal();
    const store = await getAuthStore();
    return Response.json(await store.listAccessibleProjects(principal.userId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const principal = await requireWebPrincipal();
    const raw = CreateProjectInput.parse(await req.json());
    const id = assertMemoryName(raw.slug ?? raw.project_id);
    if (id === '__shared__') throw new AuthorizationError('shared scope cannot be created');
    const store = await getAuthStore();
    if (await store.getProject(id)) return new Response('project already exists', { status: 409 });
    await store.createProject(id, principal.userId);
    return Response.json({ project_id: id, owner_user_id: principal.userId }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
