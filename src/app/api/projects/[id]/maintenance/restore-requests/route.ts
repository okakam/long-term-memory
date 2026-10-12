import { z } from 'zod';

import { assertSameOrigin } from '@/lib/auth/access';
import { requireWebPrincipal } from '@/lib/auth/web-principal';
import { errorResponse as textError } from '@/lib/http';
import { getMemoryService } from '@/lib/memory/singleton';
import { assertProjectId, SlugError } from '@/lib/slug';
import { assertSharedCurator, requestSharedRestore } from '@/lib/curation/restore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };
const LimitSchema = z.coerce.number().int().min(1).max(100).default(50);
const RestoreRequestInput = z.object({
  memory_id: z.string().min(1).max(128),
  revision_id: z.string().min(1).max(128),
  expected_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

function jsonNoStore(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function routeError(error: unknown): Response {
  if (error instanceof z.ZodError) return textError(400, 'invalid shared restore request');
  if (error instanceof SlugError) return textError(400, error.message);
  if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
    return textError(error.status, error.status === 401 ? 'authentication required'
      : error.status === 403 ? 'shared curator access denied'
        : error.status === 404 ? 'memory or revision not found'
          : error.status === 409 ? 'memory changed; reload history and retry' : 'request failed');
  }
  return textError(500, 'request failed');
}

async function authorize(req: Request, context: RouteContext) {
  const projectId = assertProjectId((await context.params).id);
  if (projectId !== '__shared__') throw Object.assign(new Error('shared project is required'), { status: 404 });
  const principal = await requireWebPrincipal(req);
  assertSharedCurator(principal);
  return principal;
}

export async function GET(req: Request, context: RouteContext): Promise<Response> {
  try {
    await authorize(req, context);
    const limit = LimitSchema.parse(new URL(req.url).searchParams.get('limit') ?? undefined);
    const requests = await getMemoryService().curationStore.listRestoreRequests(limit);
    return jsonNoStore(200, { requests });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(req);
    const principal = await authorize(req, context);
    let raw: unknown;
    try { raw = await req.json(); } catch { return textError(400, 'invalid JSON body'); }
    const input = RestoreRequestInput.parse(raw);
    const request = await requestSharedRestore(principal, input, getMemoryService());
    return jsonNoStore(202, { request });
  } catch (error) {
    return routeError(error);
  }
}
