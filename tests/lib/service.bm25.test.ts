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

test('searchFulltext は本文を検索し description を本文だけの一致より優先する', () => {
  const { db, service } = createTestService();
  try {
    service.save('project', { name: 'body-match', description: 'ordinary', type: 'project', body: 'architecture signal' });
    service.save('project', { name: 'description-match', description: 'architecture signal', type: 'project', body: 'ordinary' });
    expect(service.searchFulltext('project', 'architecture').map((memory) => memory.name)).toEqual(['description-match', 'body-match']);
  } finally { db.close(); }
});

test('searchFulltext は implicit AND が空なら OR へフォールバックする', () => {
  const { db, service } = createTestService();
  try {
    service.save('project', { name: 'first', description: 'alpha', type: 'project', body: '' });
    service.save('project', { name: 'second', description: 'beta', type: 'project', body: '' });
    expect(service.searchFulltext('project', 'alpha beta').map((memory) => memory.name).sort()).toEqual(['first', 'second']);
  } finally { db.close(); }
});
