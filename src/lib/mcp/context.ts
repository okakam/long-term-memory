import { assertProjectId } from '@/lib/slug';
import type { MemoryServiceLike } from '@/lib/memory/singleton';

export interface ToolContext {
  projectId: string;
  svc: MemoryServiceLike;
  canWriteShared?: boolean;
  principal?: { userId: string; tokenId?: string };
  sessionId?: string;
}

export function extractProjectId(url: URL): string {
  const value = url.searchParams.get('project_id');
  if (!value) throw new Error('project_id is required (provide ?project_id=<slug> in the URL)');
  return assertProjectId(value);
}

export function extractMaintenanceToken(req: Request): string | null {
  return req.headers.get('x-ltm-maintenance-token');
}
