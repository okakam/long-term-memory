import { z } from 'zod';

import { authRequired } from '@/lib/auth/config';
import { AuthorizationError, assertSameOrigin } from '@/lib/auth/access';
import { requireWebPrincipal } from '@/lib/auth/web-principal';
import { getAuthStore } from '@/lib/auth/store';
import { errorResponse as textError } from '@/lib/http';
import { getMemoryService } from '@/lib/memory/singleton';
import { MemoryConflictError } from '@/lib/memory/types';
import { MaintenanceSettingsSchema } from '@/lib/maintenance/types';
import { assertProjectId, SlugError } from '@/lib/slug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

function jsonNoStore(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function routeError(error: unknown): Response {
  if (error instanceof z.ZodError) return textError(400, 'invalid maintenance settings');
  if (error instanceof SlugError) return textError(400, error.message);
  if (error instanceof MemoryConflictError || (error instanceof Error && error.name === 'MemoryConflictError')) {
    return textError(409, 'maintenance settings changed; reload and retry');
  }
  if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
    const status = error.status;
    return textError(status, status === 401 ? 'authentication required' : status === 403 ? 'project access denied' : 'request failed');
  }
  return textError(500, 'request failed');
}

async function projectId(params: Promise<{ id: string }>): Promise<string> {
  return assertProjectId((await params).id);
}

async function requireOwner(projectId: string, req: Request): Promise<void> {
  if (projectId === '__shared__') throw new AuthorizationError('shared maintenance settings are managed by the curator');
  const principal = await requireWebPrincipal(req);
  if (!authRequired()) {
    const localUserId = process.env.LTM_LOCAL_USER_ID ?? 'local-user';
    if (principal.userId !== localUserId) throw new AuthorizationError();
    return;
  }
  // Read membership immediately before the protected settings write.
  const membership = await (await getAuthStore()).getMembership(projectId, principal.userId);
  if (membership?.role !== 'owner') throw new AuthorizationError();
}

export async function GET(req: Request, context: RouteContext): Promise<Response> {
  try {
    const id = await projectId(context.params);
    await requireOwner(id, req);
    return jsonNoStore(200, await getMemoryService().maintenanceStore.getSettings(id));
  } catch (error) {
    return routeError(error);
  }
}

export async function PATCH(req: Request, context: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(req);
    const id = await projectId(context.params);
    let raw: unknown;
    try { raw = await req.json(); } catch { return textError(400, 'invalid JSON body'); }
    const input = MaintenanceSettingsSchema.parse(raw);
    await requireOwner(id, req);
    const settings = await getMemoryService().maintenanceStore.saveSettings(id, input, input.version);
    return jsonNoStore(200, settings);
  } catch (error) {
    return routeError(error);
  }
}
