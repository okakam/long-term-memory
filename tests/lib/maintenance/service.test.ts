import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

import { computeHash } from '@/lib/markdown/file-io';
import { MemoryService } from '@/lib/memory/service';
import { DEFAULT_MAINTENANCE_SETTINGS } from '@/lib/maintenance/policy';
import { MaintenanceService } from '@/lib/maintenance/service';
import { openDb } from '@/lib/db/connection';
import { resolveStorage } from '@/lib/paths';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(now = '2026-10-12T00:00:00.000Z') {
  const root = mkdtempSync(join('/tmp', 'ltm-maintenance-service-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  const memories = MemoryService.open(db, storage);
  const maintenance = new MaintenanceService(memories, { now: () => now });
  return { storage, db, memories, maintenance };
}

async function enable(memories: MemoryService, projectId = 'project', days = 30) {
  return memories.maintenanceStore.saveSettings(projectId, {
    ...DEFAULT_MAINTENANCE_SETTINGS,
    enabled: true,
    review_days: { ...DEFAULT_MAINTENANCE_SETTINGS.review_days, project: days },
    session_archive_days: days,
  }, 0);
}

test('merges_only_compatible_memories', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  const { storage, db, memories, maintenance } = setup();
  try {
    const conflictOld = memories.save('project', {
      name: 'conflict-old', description: 'UTC timestamp policy', type: 'project',
      body: 'The application stores timestamps in UTC.',
    });
    vi.setSystemTime(new Date('2026-09-30T00:00:00.000Z'));
    const conflictNew = memories.save('project', {
      name: 'conflict-new', description: 'local timestamp policy', type: 'project',
      body: 'The application stores timestamps in local time.',
    });
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    const oldest = memories.save('project', {
      name: 'oldest-note', description: 'Older description', type: 'project',
      body: 'We keep system timestamps in UTC.', tags: ['old'], links: ['old-link'],
      entities: [{ name: 'SystemClock', aliases: ['clock'] }],
      source_refs: [{ project_id: 'origin-a', memory: 'source-a' }],
    });
    vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
    const duplicate = memories.save('project', {
      name: 'newer-note', description: 'Newer description', type: 'project',
      body: 'We   keep system timestamps in UTC.', tags: ['new'], links: ['new-link'],
      entities: [{ name: 'ClockServer', aliases: ['server'] }],
      source_refs: [{ project_id: 'origin-b', memory: 'source-b' }],
    });
    const settings = await enable(memories);
    const conflictOldHash = computeHash(readFileSync(storage.memoryFile('project', conflictOld.name), 'utf8'));
    const conflictNewHash = computeHash(readFileSync(storage.memoryFile('project', conflictNew.name), 'utf8'));
    const latestSettings = await memories.maintenanceStore.getSettings('project');
    const conflict = await maintenance.apply('project', {
      operation_id: 'merge-conflicting-claims', settings_version: latestSettings.version,
      expected_hashes: { [conflictOld.id]: conflictOldHash, [conflictNew.id]: conflictNewHash },
      action: { type: 'merge', target_id: conflictOld.id, source_id: conflictNew.id, patch: { body: conflictOld.body } },
      reason_code: 'semantic_duplicate', confidence: 0.99,
      evidence: [
        { memory_id: conflictOld.id, content_hash: conflictOldHash, start: 0, end: conflictOld.body.length },
        { memory_id: conflictNew.id, content_hash: conflictNewHash, start: 0, end: conflictNew.body.length },
      ],
    });
    expect(conflict.outcome).toBe('conflict');
    expect(memories.get('project', conflictOld.id).status).toBe('active');
    const oldestHash = computeHash(readFileSync(storage.memoryFile('project', oldest.name), 'utf8'));
    const duplicateHash = computeHash(readFileSync(storage.memoryFile('project', duplicate.name), 'utf8'));
    const result = await maintenance.apply('project', {
      operation_id: 'merge-duplicates', settings_version: settings.version,
      expected_hashes: { [oldest.id]: oldestHash, [duplicate.id]: duplicateHash },
      action: {
        type: 'merge', target_id: duplicate.id, source_id: oldest.id,
        patch: { body: oldest.body },
      },
      reason_code: 'exact_duplicate',
      evidence: [
        { memory_id: oldest.id, content_hash: oldestHash, start: 0, end: oldest.body.length },
        { memory_id: duplicate.id, content_hash: duplicateHash, start: 0, end: duplicate.body.length },
      ],
    });
    expect(result.outcome).toBe('applied');
    expect(result.memory_ids).toEqual([oldest.id, duplicate.id]);
    expect(memories.get('project', oldest.id)).toMatchObject({
      name: oldest.name,
      tags: ['old', 'new'],
      links: ['old-link', 'new-link'],
      source_refs: [
        { project_id: 'origin-a', memory: 'source-a' },
        { project_id: 'origin-b', memory: 'source-b' },
      ],
      entities: [
        { name: 'SystemClock', aliases: ['clock'] },
        { name: 'ClockServer', aliases: ['server'] },
      ],
    });
    expect(memories.get('project', duplicate.id)).toMatchObject({
      status: 'archived', archive_reason: `merged:${oldest.id}:exact_duplicate`,
    });

  } finally { db.close(); }
});

test('archives_sessions_after_configured_age', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'));
  const { storage, db, memories, maintenance } = setup();
  try {
    const saved = memories.save('project', { name: 'old-session', description: 'handoff', type: 'session', body: 'Temporary handoff details.' });
    const settings = await enable(memories, 'project', 30);
    const hash = computeHash(readFileSync(storage.memoryFile('project', saved.name), 'utf8'));
    const before30 = await maintenance.snapshot('project', '2026-10-11T00:00:00.000Z');
    expect(before30.memories.find((item) => item.memory.id === saved.id)?.due).toBe(false);

    const at30 = await maintenance.snapshot('project', '2026-10-12T00:00:00.000Z');
    expect(at30.memories.find((item) => item.memory.id === saved.id)?.due).toBe(true);
    const result = await maintenance.apply('project', {
      operation_id: 'archive-aged-session', settings_version: settings.version,
      expected_hashes: { [saved.id]: hash },
      action: { type: 'archive', memory_id: saved.id, archive_reason: 'session_aged' },
      reason_code: 'session_aged',
      evidence: [{ memory_id: saved.id, content_hash: hash, start: 0, end: saved.body.length }],
    });
    expect(result.outcome).toBe('applied');
    expect(memories.get('project', saved.id).status).toBe('archived');
  } finally { db.close(); }
});

test('removes_links_after_30_days_missing', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'));
  const { storage, db, memories, maintenance } = setup();
  try {
    const saved = memories.save('project', {
      name: 'link-owner', description: 'future reference', type: 'project', body: 'A future link should remain.',
      links: ['future-memory', 'archived-memory'],
    });
    const settings = await enable(memories);
    await maintenance.snapshot('project', '2026-09-12T00:00:00.000Z');
    const archivedTarget = memories.save('project', {
      name: 'archived-memory', description: 'retained target', type: 'project', body: 'Archived memories still resolve links.',
    });
    const targetHash = computeHash(readFileSync(storage.memoryFile('project', archivedTarget.name), 'utf8'));
    await memories.applyMutationAsync({
      operation_id: 'archive-link-target', project_id: 'project', expected_hashes: { [archivedTarget.id]: targetHash },
      expected_settings_version: settings.version,
      action: { type: 'archive', memory_id: archivedTarget.id, archive_reason: 'completed' },
      reason_code: 'completed', now: '2026-09-12T00:01:00.000Z',
    });
    memories.reindex('project');
    const before30 = await maintenance.snapshot('project', '2026-10-11T00:00:00.000Z');
    expect(before30.memories.find((item) => item.memory.id === saved.id)?.missing_links).toEqual([]);
    expect(memories.get('project', saved.id).links).toEqual(['future-memory', 'archived-memory']);

    const after30 = await maintenance.snapshot('project', '2026-10-12T00:00:00.000Z');
    expect(after30.memories.find((item) => item.memory.id === saved.id)?.missing_links).toContain('future-memory');
    expect(after30.memories.find((item) => item.memory.id === saved.id)?.missing_links).not.toContain('archived-memory');
    const hash = computeHash(readFileSync(storage.memoryFile('project', saved.name), 'utf8'));
    const result = await maintenance.apply('project', {
      operation_id: 'remove-old-missing-link', settings_version: settings.version,
      expected_hashes: { [saved.id]: hash },
      action: { type: 'prune_links', memory_id: saved.id, names: ['future-memory'] },
      reason_code: 'missing_link',
      evidence: [{ memory_id: saved.id, content_hash: hash, start: 0, end: saved.body.length }],
    });
    expect(result.outcome).toBe('applied');
    expect(memories.get('project', saved.id).links).not.toContain('future-memory');
  } finally { db.close(); }
});
