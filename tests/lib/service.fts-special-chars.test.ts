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

test('searchFulltext は FTS special character を含む query で throw しない', () => {
  const { db, service } = createTestService();
  try {
    service.save('project', { name: 'server-connect', description: 'better sqlite', type: 'project', body: 'Server.connect and better-sqlite3' });
    expect(() => service.searchFulltext('project', 'better-sqlite3')).not.toThrow();
    expect(() => service.searchFulltext('project', 'Server.connect')).not.toThrow();
    expect(service.searchFulltext('project', '---...:::')).toEqual([]);
  } finally { db.close(); }
});
