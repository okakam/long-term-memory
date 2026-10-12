import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

import { computeHash } from '@/lib/markdown/file-io';
import { MemoryService } from '@/lib/memory/service';
import { DEFAULT_MAINTENANCE_SETTINGS } from '@/lib/maintenance/policy';
import { encodeMaintenanceEventCursor } from '@/lib/maintenance/cursor';
import { openDb } from '@/lib/db/connection';
import { resolveStorage } from '@/lib/paths';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('archive一覧はarchived記憶だけを返し、同時刻のevent cursorも次ページを落とさない', async () => {
  const root = mkdtempSync(join('/tmp', 'ltm-maintenance-archives-'));
  roots.push(root);
  vi.stubEnv('LTM_HOME', root);
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  const memories = MemoryService.open(db, storage);
  try {
    const first = memories.save('project', { name: 'first-note', description: 'first', type: 'project', body: 'first body' });
    const second = memories.save('project', { name: 'second-note', description: 'second', type: 'project', body: 'second body' });
    const settings = await memories.maintenanceStore.saveSettings('project', {
      ...DEFAULT_MAINTENANCE_SETTINGS, enabled: true,
    }, 0);
    const now = '2026-10-12T12:00:00.000Z';
    for (const [operationId, memory] of [['archive-a', first], ['archive-b', second]] as const) {
      const raw = readFileSync(storage.memoryFile('project', memory.name), 'utf8');
      const result = await memories.applyMutationAsync({
        operation_id: operationId,
        project_id: 'project',
        expected_hashes: { [memory.id]: computeHash(raw) },
        expected_settings_version: settings.version,
        action: { type: 'archive', memory_id: memory.id, archive_reason: 'completed' },
        reason_code: 'completed',
        now,
      });
      expect(result.outcome).toBe('applied');
    }

    const active = await memories.listMaintenanceMemories('project');
    expect(active.items).toHaveLength(0);
    const archived = await memories.listArchivedMaintenanceMemories('project', undefined, 1);
    expect(archived.items).toHaveLength(1);
    expect(archived.items[0]?.memory.status).toBe('archived');
    expect(archived.next_after).toBeTruthy();

    const events = await memories.maintenanceStore.listEvents('project', undefined, 1);
    expect(events).toHaveLength(1);
    const olderEvents = await memories.maintenanceStore.listEvents('project', encodeMaintenanceEventCursor(events[0]!), 1);
    expect(olderEvents).toHaveLength(1);
    expect(olderEvents[0]?.operation_id).not.toBe(events[0]?.operation_id);
  } finally {
    db.close();
  }
});
