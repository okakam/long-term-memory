import { z } from 'zod';

import { assertSameOrigin, assertProjectAccess } from '@/lib/auth/access';
import { authRequired } from '@/lib/auth/config';
import { requireWebPrincipal } from '@/lib/auth/clerk';
import { getMemoryService } from '@/lib/memory/singleton';
import { MemoryNotFoundError } from '@/lib/memory/types';
import { assertProjectId, SHARED_PROJECT_ID, SlugError } from '@/lib/slug';
import { errorResponse, jsonResponse } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  description: z.string().min(1).optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  links: z.array(z.string()).optional(),
}).strict();

type RouteContext = { params: Promise<{ id: string }> };

function projectIdFrom(req: Request): string {
  const value = new URL(req.url).searchParams.get('project_id');
  if (!value) throw new Error('project_id query param required');
  return assertProjectId(value);
}

function routeError(error: unknown): Response {
  if (error instanceof MemoryNotFoundError || (error instanceof Error && error.name === 'MemoryNotFoundError')) {
    return errorResponse(404, error instanceof Error ? error.message : 'memory not found');
  }
  if (error instanceof SlugError) return errorResponse(400, error.message);
  if (error instanceof Error && error.message === 'project_id query param required') return errorResponse(400, error.message);
  if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
    return errorResponse(error.status, error.message);
  }
  return errorResponse(500, 'request failed');
}

async function authorizeMutation(projectId: string, req: Request): Promise<void> {
  assertSameOrigin(req);
  if (authRequired()) {
    const principal = await requireWebPrincipal();
    await assertProjectAccess(principal, projectId, 'write');
  }
  if (projectId === SHARED_PROJECT_ID) throw Object.assign(new Error('shared scope is read-only'), { status: 403 });
}

export async function PUT(req: Request, context: RouteContext): Promise<Response> {
  try {
    const projectId = projectIdFrom(req);
    await authorizeMutation(projectId, req);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return errorResponse(400, 'invalid JSON body');
    }
    const parsed = PatchSchema.safeParse(raw);
    if (!parsed.success) return errorResponse(400, parsed.error.message);
    const { id } = await context.params;
    const memory = await getMemoryService().updateAsync(projectId, id, parsed.data);
    return jsonResponse(200, memory);
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(req: Request, context: RouteContext): Promise<Response> {
  try {
    const projectId = projectIdFrom(req);
    await authorizeMutation(projectId, req);
    const { id } = await context.params;
    await getMemoryService().forgetAsync(projectId, id);
    return jsonResponse(200, { deleted: true });
  } catch (error) {
    return routeError(error);
  }
}
