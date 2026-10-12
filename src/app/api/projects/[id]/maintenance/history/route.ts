import { z } from 'zod';

import { authRequired } from '@/lib/auth/config';
import { AuthorizationError } from '@/lib/auth/access';
import { requireWebPrincipal } from '@/lib/auth/web-principal';
import { getAuthStore } from '@/lib/auth/store';
import { errorResponse as textError } from '@/lib/http';
import { getMemoryService } from '@/lib/memory/singleton';
import { encodeMaintenanceEventCursor, MaintenanceCursorError } from '@/lib/maintenance/cursor';
import { assertProjectId, SlugError } from '@/lib/slug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const LimitSchema = z.coerce.number().int().min(1).max(100).default(30);

function jsonNoStore(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function routeError(error: unknown): Response {
  if (error instanceof z.ZodError) return textError(400, 'invalid history query');
  if (error instanceof MaintenanceCursorError) return textError(400, 'invalid history cursor');
  if (error instanceof SlugError) return textError(400, error.message);
  if (error instanceof Error && error.name === 'MemoryNotFoundError') return textError(404, 'memory not found');
  if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
    const status = error.status;
    return textError(status, status === 401 ? 'authentication required' : status === 403 ? 'project access denied' : 'request failed');
  }
  return textError(500, 'request failed');
}

async function requireHistoryReader(projectId: string, req: Request): Promise<void> {
  const principal = await requireWebPrincipal(req);
  if (projectId === '__shared__') {
    if (!process.env.LTM_CURATOR_USER_ID || principal.userId !== process.env.LTM_CURATOR_USER_ID) throw new AuthorizationError();
    return;
  }
  if (!authRequired()) {
    const localUserId = process.env.LTM_LOCAL_USER_ID ?? 'local-user';
    if (principal.userId !== localUserId) throw new AuthorizationError();
    return;
  }
  const membership = await (await getAuthStore()).getMembership(projectId, principal.userId);
  if (membership?.role !== 'owner') throw new AuthorizationError();
}

function archiveSummary(memory: {
  id: string;
  name: string;
  description: string;
  type: string;
  created_at: string;
  updated_at: string;
  archived_at?: string;
  archive_reason?: string;
}, currentHash: string) {
  return {
    memory_id: memory.id,
    name: memory.name,
    description: memory.description,
    type: memory.type,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    archived_at: memory.archived_at ?? null,
    archive_reason: memory.archive_reason ?? null,
    current_hash: currentHash,
  };
}

export async function GET(req: Request, context: RouteContext): Promise<Response> {
  try {
    const projectId = assertProjectId((await context.params).id);
    await requireHistoryReader(projectId, req);
    const url = new URL(req.url);
    const limit = LimitSchema.parse(url.searchParams.get('limit') ?? undefined);
    const after = url.searchParams.get('after') ?? undefined;
    const memoryId = url.searchParams.get('memory_id') ?? undefined;
    const memoryService = getMemoryService();
    const [events, archivesPage] = await Promise.all([
      memoryService.maintenanceStore.listEvents(projectId, after, limit),
      memoryService.listArchivedMaintenanceMemories(projectId, url.searchParams.get('archive_after') ?? undefined, limit),
    ]);
    let selectedMemory: Record<string, unknown> | null = null;
    if (memoryId) {
      const current = await memoryService.getMaintenanceMemory(projectId, memoryId);
      if (!current) return textError(404, 'memory not found');
      const allRevisions = await memoryService.listRevisionsAsync(projectId, memoryId);
      const revisionAfter = url.searchParams.get('revision_after') ?? undefined;
      const cursorIndex = revisionAfter ? allRevisions.findIndex((item) => item.id === revisionAfter) : -1;
      if (revisionAfter && cursorIndex < 0) return textError(400, 'invalid revision cursor');
      const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
      const page = allRevisions.slice(start, start + limit + 1);
      const hasMore = page.length > limit;
      selectedMemory = {
        memory_id: current.memory.id,
        name: current.memory.name,
        status: current.memory.status ?? 'active',
        current_hash: current.content_hash,
        revisions: page.slice(0, limit).map((revision) => ({
          id: revision.id,
          memory_id: revision.memory_id,
          content_hash: revision.content_hash,
          created_at: revision.created_at,
          operation_id: revision.operation_id,
          reason_code: revision.reason_code,
        })),
        next_revision_after: hasMore ? page[limit - 1]!.id : null,
      };
    }
    const archiveHasMore = archivesPage.next_after !== null;
    const nextEvent = events.length === limit ? events[events.length - 1] : undefined;
    return jsonNoStore(200, {
      events,
      next_event_after: nextEvent ? encodeMaintenanceEventCursor(nextEvent) : null,
      archives: archivesPage.items.map(({ memory, content_hash }) => archiveSummary(memory, content_hash)),
      next_archive_after: archiveHasMore ? archivesPage.next_after : null,
      selected_memory: selectedMemory,
    });
  } catch (error) {
    return routeError(error);
  }
}
