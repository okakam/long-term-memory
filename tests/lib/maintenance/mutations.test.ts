import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { openDb } from '@/lib/db/connection';
import { computeHash } from '@/lib/markdown/file-io';
import { MemoryService } from '@/lib/memory/service';
import { DEFAULT_MAINTENANCE_SETTINGS } from '@/lib/maintenance/policy';
import { resolveStorage } from '@/lib/paths';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function createService() {
  const root = mkdtempSync(join('/tmp', 'ltm-maintenance-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  return { storage, db, service: MemoryService.open(db, storage) };
}

async function enableMaintenance(service: MemoryService, projectId = 'project') {
  return service.maintenanceStore.saveSettings(projectId, { ...DEFAULT_MAINTENANCE_SETTINGS, enabled: true }, 0);
}

test('preserves_revision_and_rejects_stale_hash', async () => {
  const { service, storage, db } = createService();
  try {
    const saved = service.save('project', { name: 'mutable-memory', description: 'before', type: 'project', body: 'before body' });
    const settings = await enableMaintenance(service);
    const originalHash = computeHash(readFileSync(storage.memoryFile('project', saved.name), 'utf8'));
    const applied = await service.applyMutationAsync({
      operation_id: 'patch-before-manual-edit', project_id: 'project',
      expected_hashes: { [saved.id]: originalHash }, expected_settings_version: settings.version,
      action: { type: 'patch', memory_id: saved.id, patch: { body: 'automated body' } },
      reason_code: 'confirmed', now: '2026-10-12T00:00:00.000Z',
    });
    expect(applied.outcome).toBe('applied');
    expect(service.get('project', saved.id).body).toBe('automated body');
    expect(await service.listRevisionsAsync('project', saved.id)).toMatchObject([
      { content_hash: originalHash, operation_id: 'patch-before-manual-edit', reason_code: 'confirmed' },
    ]);

    const automatedHash = computeHash(readFileSync(storage.memoryFile('project', saved.name), 'utf8'));
    service.update('project', saved.id, { body: 'manual edit' });
    const stale = await service.applyMutationAsync({
      operation_id: 'stale-automated-patch', project_id: 'project',
      expected_hashes: { [saved.id]: automatedHash }, expected_settings_version: settings.version,
      action: { type: 'patch', memory_id: saved.id, patch: { body: 'must not overwrite manual edit' } },
      reason_code: 'confirmed', now: '2026-10-12T00:01:00.000Z',
    });
    expect(stale.outcome).toBe('conflict');
    expect(service.get('project', saved.id).body).toBe('manual edit');
    expect(await service.listRevisionsAsync('project', saved.id)).toHaveLength(1);
  } finally { db.close(); }
});

test('retry_does_not_duplicate_revision', async () => {
  const { service, storage, db } = createService();
  try {
    const saved = service.save('project', { name: 'idempotent-memory', description: 'before', type: 'project', body: 'before body' });
    const settings = await enableMaintenance(service);
    const hash = computeHash(readFileSync(storage.memoryFile('project', saved.name), 'utf8'));
    const request = {
      operation_id: 'same-operation', project_id: 'project', expected_hashes: { [saved.id]: hash },
      expected_settings_version: settings.version,
      action: { type: 'patch' as const, memory_id: saved.id, patch: { body: 'after body' } },
      reason_code: 'confirmed' as const, now: '2026-10-12T00:00:00.000Z',
    };

    expect((await service.applyMutationAsync(request)).outcome).toBe('applied');
    expect((await service.applyMutationAsync(request)).outcome).toBe('already_applied');
    expect(await service.listRevisionsAsync('project', saved.id)).toHaveLength(1);
  } finally { db.close(); }
});

test('reindex_keeps_archive_hidden', async () => {
  const { service, db } = createService();
  try {
    const saved = service.save('project', {
      name: 'archived-memory', description: 'archive candidate', type: 'project', body: 'archive candidate body',
      entities: [{ name: 'ArchiveCandidate', aliases: [] }],
    });
    expect(service.kgStats('project').memberships).toBe(1);
    const settings = await enableMaintenance(service);
    const hash = computeHash(readFileSync(resolveStorage().memoryFile('project', saved.name), 'utf8'));
    const result = await service.applyMutationAsync({
      operation_id: 'archive-memory', project_id: 'project', expected_hashes: { [saved.id]: hash },
      expected_settings_version: settings.version,
      action: { type: 'archive', memory_id: saved.id, archive_reason: 'completed' },
      reason_code: 'completed', now: '2026-10-12T00:00:00.000Z',
    });

    expect(result.outcome).toBe('applied');
    expect(service.listByType('project', 'project')).toEqual([]);
    expect(service.searchFulltext('project', 'archive candidate')).toEqual([]);
    expect(service.kgStats('project').memberships).toBe(0);
    expect(service.get('project', saved.id).status).toBe('archived');

    service.reindex('project');
    expect(service.listByType('project', 'project')).toEqual([]);
    expect(service.searchFulltext('project', 'archive candidate')).toEqual([]);
    expect(service.get('project', saved.id).status).toBe('archived');
  } finally { db.close(); }
});

test('restore_uses_revision_body_and_reactivates_memory', async () => {
  const { service, storage, db } = createService();
  try {
    const saved = service.save('project', { name: 'restorable', description: 'before', type: 'reference', body: 'original body' });
    const settings = await enableMaintenance(service);
    const initialHash = computeHash(readFileSync(storage.memoryFile('project', saved.name), 'utf8'));
    await service.applyMutationAsync({
      operation_id: 'patch-for-restore', project_id: 'project', expected_hashes: { [saved.id]: initialHash },
      expected_settings_version: settings.version,
      action: { type: 'patch', memory_id: saved.id, patch: { body: 'temporary body' } },
      reason_code: 'confirmed', now: '2026-10-12T00:00:00.000Z',
    });
    const patchRevision = (await service.listRevisionsAsync('project', saved.id))[0]!;
    const currentHash = computeHash(readFileSync(storage.memoryFile('project', saved.name), 'utf8'));
    const restored = await service.applyMutationAsync({
      operation_id: 'restore-original', project_id: 'project', expected_hashes: { [saved.id]: currentHash },
      action: { type: 'restore', memory_id: saved.id, revision_id: patchRevision.id },
      reason_code: 'restored', now: '2026-10-12T00:02:00.000Z',
    });
    expect(restored.outcome).toBe('applied');
    expect(service.get('project', saved.id)).toMatchObject({ body: 'original body', status: 'active', name: 'restorable' });
    expect(service.searchFulltext('project', 'original body').map((memory) => memory.id)).toContain(saved.id);
  } finally { db.close(); }
});

test('manual_forget_deletes_revision_metadata_and_bodies', async () => {
  const { service, storage, db } = createService();
  try {
    const saved = service.save('project', { name: 'forget-revisions', description: 'before', type: 'reference', body: 'before body' });
    const settings = await enableMaintenance(service);
    const hash = computeHash(readFileSync(storage.memoryFile('project', saved.name), 'utf8'));
    await service.applyMutationAsync({
      operation_id: 'patch-before-forget', project_id: 'project', expected_hashes: { [saved.id]: hash },
      expected_settings_version: settings.version,
      action: { type: 'patch', memory_id: saved.id, patch: { body: 'after body' } },
      reason_code: 'confirmed', now: '2026-10-12T00:00:00.000Z',
    });
    const [revision] = await service.listRevisionsAsync('project', saved.id);
    expect(revision).toBeDefined();
    service.forget('project', saved.id);
    expect(await service.listRevisionsAsync('project', saved.id)).toEqual([]);
    expect(existsSync(revision!.content_key)).toBe(false);
    await expect(service.applyMutationAsync({
      operation_id: 'restore-after-forget', project_id: 'project', expected_hashes: {},
      action: { type: 'restore', memory_id: saved.id, revision_id: revision!.id },
      reason_code: 'restored', now: '2026-10-12T00:02:00.000Z',
    })).rejects.toThrow(`memory not found: ${saved.id}`);
  } finally { db.close(); }
});
