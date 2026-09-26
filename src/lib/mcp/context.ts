import { assertProjectAccess, AuthorizationError, type ProjectAction } from '@/lib/auth/access';
import { authRequired } from '@/lib/auth/config';
import { UnauthorizedMcpError } from '@/lib/auth/pat';
import type { MemoryServiceLike } from '@/lib/memory/singleton';
import { assertProjectId, SHARED_PROJECT_ID } from '@/lib/slug';
import { grantsSharedWrite } from './auth';
import type { McpPrincipal } from './principal';

export type RequireProjectAccess = (projectId: string, action: ProjectAction) => Promise<void>;

export interface ProjectAccessOptions {
  principal?: McpPrincipal;
  maintenanceToken: string | null;
}

export interface ToolContext {
  /** @deprecated Kept only until all tool handlers use their input project_id. */
  projectId: string;
  svc: MemoryServiceLike;
  canWriteShared?: boolean;
  principal?: McpPrincipal;
  maintenanceToken?: string | null;
  requireProjectAccess: RequireProjectAccess;
  sessionId?: string;
}

export function createProjectAccessGuard({ principal, maintenanceToken }: ProjectAccessOptions): RequireProjectAccess {
  return async (projectId, action) => {
    assertProjectId(projectId);
    if (authRequired() && !principal) throw new UnauthorizedMcpError();
    if (projectId === SHARED_PROJECT_ID && action !== 'read') {
      if (!grantsSharedWrite(maintenanceToken)
        || (authRequired() && (principal?.credentialKind !== 'pat'
          || principal.userId !== process.env.LTM_CURATOR_USER_ID))) {
        throw new AuthorizationError('shared scope is read-only');
      }
      if (!authRequired()) return;
      await assertProjectAccess(principal!, projectId, 'maintain');
      return;
    }
    if (!authRequired()) return;
    await assertProjectAccess(principal!, projectId, action);
  };
}

export function extractMaintenanceToken(req: Request): string | null {
  return req.headers.get('x-ltm-maintenance-token');
}
