import { AuthorizationError } from '@/lib/auth/access';
import type { MemoryServiceLike } from '@/lib/memory/singleton';
import type { SharedRestoreRequest } from './types';

export interface SharedRestoreInput {
  memory_id: string;
  revision_id: string;
  expected_hash: string;
}

export function assertSharedCurator(principal: { userId: string }): void {
  if (!process.env.LTM_CURATOR_USER_ID || principal.userId !== process.env.LTM_CURATOR_USER_ID) {
    throw new AuthorizationError();
  }
}

export async function requestSharedRestore(
  principal: { userId: string },
  input: SharedRestoreInput,
  service: MemoryServiceLike,
  now = new Date().toISOString(),
): Promise<SharedRestoreRequest> {
  assertSharedCurator(principal);
  const current = await service.getMaintenanceMemory('__shared__', input.memory_id);
  if (!current) throw Object.assign(new Error('memory not found'), { status: 404 });
  if (current.content_hash !== input.expected_hash) throw Object.assign(new Error('memory changed'), { status: 409 });
  const revisions = await service.listRevisionsAsync('__shared__', input.memory_id);
  if (!revisions.some((revision) => revision.id === input.revision_id)) {
    throw Object.assign(new Error('revision not found'), { status: 404 });
  }
  return service.curationStore.createRestoreRequest({
    memory_id: input.memory_id,
    revision_id: input.revision_id,
    expected_hash: input.expected_hash,
    requested_by: principal.userId,
    requested_at: now,
  });
}

export async function applySharedRestore(
  requestId: string,
  service: MemoryServiceLike,
  now = new Date().toISOString(),
): Promise<SharedRestoreRequest> {
  const request = await service.curationStore.getRestoreRequest(requestId);
  if (!request) throw Object.assign(new Error('restore request not found'), { status: 404 });
  if (request.state !== 'pending') return request;

  let failureReason: SharedRestoreRequest['failure_reason'];
  try {
    const current = await service.getMaintenanceMemory('__shared__', request.memory_id);
    if (!current || current.content_hash !== request.expected_hash) failureReason = 'memory_changed';
    else {
      const revisions = await service.listRevisionsAsync('__shared__', request.memory_id);
      if (!revisions.some((revision) => revision.id === request.revision_id)) failureReason = 'revision_missing';
      else {
        const result = await service.applyMutationAsync({
          operation_id: `shared-restore-${request.id}`,
          project_id: '__shared__',
          expected_hashes: { [request.memory_id]: request.expected_hash },
          action: { type: 'restore', memory_id: request.memory_id, revision_id: request.revision_id },
          reason_code: 'restored',
          now,
        });
        if (result.outcome === 'conflict') failureReason = 'restore_conflict';
      }
    }
  } catch {
    failureReason = 'restore_unavailable';
  }

  return service.curationStore.completeRestoreRequest(request.id, {
    state: failureReason ? 'failed' : 'succeeded',
    completed_at: now,
    ...(failureReason ? { failure_reason: failureReason } : {}),
  });
}
