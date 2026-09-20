import { expect, test } from 'vitest';

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach } from 'vitest';

import { openDb } from '@/lib/db/connection';
import { MemoryService } from '@/lib/memory/service';
import { resolveStorage } from '@/lib/paths';

export const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
export function createTestService() {
  const root = mkdtempSync(join('/tmp', 'ltm-search-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  return { db, service: MemoryService.open(db, storage) };
}

test('searchAssociative は superseded を降格し type filter 後の候補で rerank する', () => {
  const { db, service } = createTestService();
  try {
    service.save('project', { name: 'old-fact', description: 'architecture', type: 'project', body: 'architecture' });
    service.save('project', { name: 'current-fact', description: 'architecture architecture', type: 'project', body: 'architecture', supersedes: ['old-fact'] });
    db.prepare("UPDATE memories SET updated_at = '2025-01-01T00:00:00.000Z' WHERE name = 'old-fact'").run();
    db.prepare("UPDATE memories SET updated_at = '2026-09-04T00:00:00.000Z' WHERE name = 'current-fact'").run();
    expect(service.searchAssociative('project', 'architecture').map((memory) => memory.name)[0]).toBe('current-fact');
    expect(service.searchAssociative('project', 'architecture', { type: 'project' }).map((memory) => memory.name)[0]).toBe('current-fact');
  } finally { db.close(); }
});
