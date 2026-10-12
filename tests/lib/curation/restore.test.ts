import { afterEach, expect, test, vi } from 'vitest';

import { LocalCurationStore } from '@/lib/curation/local-store';
import { applySharedRestore, requestSharedRestore } from '@/lib/curation/restore';
import type { MemoryServiceLike } from '@/lib/memory/singleton';

const memoryId = 'memory-1';
const hash = 'a'.repeat(64);
const revision = { id: 'revision-1', memory_id: memoryId, content_key: 'private/key', content_hash: 'b'.repeat(64), created_at: '2026-10-01T00:00:00.000Z', operation_id: 'op-1', reason_code: 'completed' as const };

function fixture() {
  const store = new LocalCurationStore(':memory:');
  let currentHash = hash;
  let revisions = [revision];
  const service = {
    curationStore: store,
    getMaintenanceMemory: vi.fn(async () => ({
      memory: { id: memoryId, name: 'shared-note', status: 'archived' as const, body: 'private body' },
      content_hash: currentHash,
    })),
    listRevisionsAsync: vi.fn(async () => revisions),
    applyMutationAsync: vi.fn(async () => ({ operation_id: 'restore-operation', outcome: 'applied' as const, memory_ids: [memoryId], revision_ids: ['new-revision'] })),
  } as unknown as MemoryServiceLike;
  return {
    store,
    service,
    setHash(value: string) { currentHash = value; },
    setRevisions(value: typeof revisions) { revisions = value; },
  };
}

afterEach(() => vi.unstubAllEnvs());

test('only curator can create a pending shared restore request', async () => {
  vi.stubEnv('LTM_CURATOR_USER_ID', 'curator');
  const { service, store } = fixture();
  try {
    await expect(requestSharedRestore({ userId: 'member' }, {
      memory_id: memoryId, revision_id: revision.id, expected_hash: hash,
    }, service)).rejects.toMatchObject({ status: 403 });
    await expect(requestSharedRestore({ userId: 'curator' }, {
      memory_id: memoryId, revision_id: revision.id, expected_hash: hash,
    }, service, '2026-10-12T00:00:00.000Z')).resolves.toMatchObject({
      memory_id: memoryId, revision_id: revision.id, expected_hash: hash,
      requested_by: 'curator', state: 'pending', requested_at: '2026-10-12T00:00:00.000Z',
    });
    expect(await store.listRestoreRequests()).toHaveLength(1);
  } finally {
    store.close();
  }
});

test('restore worker rechecks current hash and revision and marks stale requests failed', async () => {
  const { service, store, setHash, setRevisions } = fixture();
  try {
    const changed = await store.createRestoreRequest({
      memory_id: memoryId, revision_id: revision.id, expected_hash: hash, requested_by: 'curator', requested_at: '2026-10-12T00:00:00.000Z',
    });
    setHash('c'.repeat(64));
    await expect(applySharedRestore(changed.id, service, '2026-10-12T01:00:00.000Z')).resolves.toMatchObject({
      state: 'failed', failure_reason: 'memory_changed',
    });

    const missingRevision = await store.createRestoreRequest({
      memory_id: memoryId, revision_id: revision.id, expected_hash: 'c'.repeat(64), requested_by: 'curator', requested_at: '2026-10-12T00:00:00.000Z',
    });
    setRevisions([]);
    await expect(applySharedRestore(missingRevision.id, service, '2026-10-12T01:00:00.000Z')).resolves.toMatchObject({
      state: 'failed', failure_reason: 'revision_missing',
    });
    expect(service.applyMutationAsync).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

test('restore request applies once with a stable mutation operation id', async () => {
  const { service, store } = fixture();
  try {
    const request = await store.createRestoreRequest({
      memory_id: memoryId, revision_id: revision.id, expected_hash: hash, requested_by: 'curator', requested_at: '2026-10-12T00:00:00.000Z',
    });
    await expect(applySharedRestore(request.id, service, '2026-10-12T01:00:00.000Z')).resolves.toMatchObject({ state: 'succeeded' });
    await expect(applySharedRestore(request.id, service, '2026-10-12T02:00:00.000Z')).resolves.toMatchObject({ state: 'succeeded' });
    expect(service.applyMutationAsync).toHaveBeenCalledTimes(1);
    expect(service.applyMutationAsync).toHaveBeenCalledWith(expect.objectContaining({
      operation_id: `shared-restore-${request.id}`,
      project_id: '__shared__', expected_hashes: { [memoryId]: hash },
      action: { type: 'restore', memory_id: memoryId, revision_id: revision.id },
    }));
  } finally {
    store.close();
  }
});

test.each(['getMaintenanceMemory', 'listRevisionsAsync', 'applyMutationAsync'] as const)(
  'transient %s errors keep the restore request pending for a later write run', async (operation) => {
    const { service, store } = fixture();
    try {
      const request = await store.createRestoreRequest({
        memory_id: memoryId, revision_id: revision.id, expected_hash: hash, requested_by: 'curator', requested_at: '2026-10-12T00:00:00.000Z',
      });
      vi.mocked(service[operation]).mockRejectedValueOnce(new Error('temporary storage failure'));

      const pending = await applySharedRestore(request.id, service, '2026-10-12T01:00:00.000Z');
      expect(pending).toMatchObject({ id: request.id, state: 'pending' });
      expect(pending).not.toHaveProperty('completed_at');
      await expect(store.getRestoreRequest(request.id)).resolves.toMatchObject({ state: 'pending' });
      await expect(applySharedRestore(request.id, service, '2026-10-12T02:00:00.000Z')).resolves.toMatchObject({
        id: request.id, state: 'succeeded',
      });
    } finally {
      store.close();
    }
  },
);
