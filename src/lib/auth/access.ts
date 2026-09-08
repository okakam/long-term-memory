import { assertProjectId } from '@/lib/slug';
import { getAuthStore, type AuthStore } from './store';

export type ProjectAction = 'read' | 'write' | 'maintain';

export class AuthorizationError extends Error {
  readonly status = 403;
  constructor(message = 'project access denied') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export class CsrfError extends Error {
  readonly status = 403;
  constructor() {
    super('same-origin request required');
    this.name = 'CsrfError';
  }
}

export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (!origin || !host) throw new CsrfError();
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new CsrfError();
  }
  const requestUrl = new URL(req.url);
  const expectedOrigin = originUrl.protocol + '//' + host;
  if (originUrl.origin !== expectedOrigin || originUrl.protocol !== requestUrl.protocol) {
    throw new CsrfError();
  }
}

export async function assertProjectAccess(
  principal: { userId: string },
  projectId: string,
  action: ProjectAction,
  store?: AuthStore,
): Promise<void> {
  assertProjectId(projectId);
  if (projectId === '__shared__') {
    if (action === 'read') return;
    if (action === 'maintain' && principal.userId === process.env.LTM_CURATOR_USER_ID) return;
    throw new AuthorizationError('shared scope is read-only');
  }
  const membership = await (store ?? await getAuthStore()).getMembership(projectId, principal.userId);
  if (!membership || (membership.role !== 'owner' && membership.role !== 'member')) {
    throw new AuthorizationError();
  }
  if (action === 'maintain' && membership.role !== 'owner') throw new AuthorizationError();
}
