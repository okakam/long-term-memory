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

test('searchAssociative は FTS キーワードが無くても entity seed から memory を想起する', () => {
  const { db, service } = createTestService();
  try {
    service.save('project', { name: 'entity-memory', description: 'ordinary', type: 'project', body: 'unrelated body', entities: [{ name: 'SQLite', aliases: ['db'] }], triples: [] });
    expect(service.searchAssociative('project', 'never-mentioned', { queryEntities: ['sqlite'] }).map((memory) => memory.name)).toContain('entity-memory');
    expect(service.searchAssociative('project', 'never-mentioned', { queryEntities: ['unknown'] })).toEqual([]);
  } finally { db.close(); }
});
