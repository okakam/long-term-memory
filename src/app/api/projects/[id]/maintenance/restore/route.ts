import { z } from 'zod';

import { authRequired } from '@/lib/auth/config';
import { AuthorizationError, assertSameOrigin } from '@/lib/auth/access';
import { requireWebPrincipal } from '@/lib/auth/web-principal';
import { getAuthStore } from '@/lib/auth/store';
import { errorResponse as textError } from '@/lib/http';
import { getMemoryService } from '@/lib/memory/singleton';
import { MemoryConflictError } from '@/lib/memory/types';
import { assertProjectId, SlugError } from '@/lib/slug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

function jsonNoStore(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

const RestoreInput = z.object({
  memory_id: z.string().min(1).max(128),
  revision_id: z.string().min(1).max(128),
  expected_hash: z.string().regex(/^[a-f0-9]{64}$/),
  operation_id: z.string().min(1).max(128),
}).strict();

function routeError(error: unknown): Response {
  if (error instanceof z.ZodError) return textError(400, 'invalid restore request');
  if (error instanceof SlugError) return textError(400, error.message);
  if (error instanceof Error && error.name === 'MemoryNotFoundError') return textError(404, 'memory or revision not found');
  if (error instanceof MemoryConflictError || (error instanceof Error && error.name === 'MemoryConflictError')) {
    return textError(409, 'memory changed; reload history and retry');
  }
  if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
    const status = error.status;
    return textError(status, status === 401 ? 'authentication required' : status === 403 ? 'project access denied' : 'request failed');
  }
  return textError(500, 'request failed');
}

async function requireOwner(projectId: string, req: Request): Promise<void> {
  if (projectId === '__shared__') throw new AuthorizationError('shared memories cannot be restored through this endpoint');
  const principal = await requireWebPrincipal(req);
  if (!authRequired()) {
    const localUserId = process.env.LTM_LOCAL_USER_ID ?? 'local-user';
    if (principal.userId !== localUserId) throw new AuthorizationError();
    return;
  }
  // Re-read Firestore membership immediately before committing the restore.
  const membership = await (await getAuthStore()).getMembership(projectId, principal.userId);
  if (membership?.role !== 'owner') throw new AuthorizationError();
}

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(req);
    const projectId = assertProjectId((await context.params).id);
    if (projectId === '__shared__') throw new AuthorizationError('shared memories cannot be restored through this endpoint');
    await requireOwner(projectId, req);
    let raw: unknown;
    try { raw = await req.json(); } catch { return textError(400, 'invalid JSON body'); }
    const input = RestoreInput.parse(raw);
    const memoryService = getMemoryService();
    const current = await memoryService.getMaintenanceMemory(projectId, input.memory_id);
    if (!current) return textError(404, 'memory not found');
    if (current.content_hash !== input.expected_hash) return textError(409, 'memory changed; reload history and retry');
    const revisions = await memoryService.listRevisionsAsync(projectId, input.memory_id);
    if (!revisions.some((revision) => revision.id === input.revision_id)) return textError(404, 'revision not found');

    await requireOwner(projectId, req);
    const result = await memoryService.applyMutationAsync({
      operation_id: input.operation_id,
      project_id: projectId,
      expected_hashes: { [input.memory_id]: input.expected_hash },
      action: { type: 'restore', memory_id: input.memory_id, revision_id: input.revision_id },
      reason_code: 'restored',
      now: new Date().toISOString(),
    });
    if (result.outcome === 'conflict') return textError(409, 'memory changed; reload history and retry');
    return jsonNoStore(200, {
      operation_id: result.operation_id,
      outcome: result.outcome,
      memory_id: input.memory_id,
      status: 'active',
      revision_ids: result.revision_ids,
    });
  } catch (error) {
    return routeError(error);
  }
}
