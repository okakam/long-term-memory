import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { openDb } from '@/lib/db/connection';
import { MemoryService } from '@/lib/memory/service';
import { resolveStorage } from '@/lib/paths';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('supersedes は同一 project の逆引きだけを作り自己参照を無視する', () => {
  const root = mkdtempSync(join('/tmp', 'ltm-supersedes-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  const service = MemoryService.open(db, storage);
  try {
    service.save('project', { name: 'old', description: 'old', type: 'project', body: '' });
    service.save('project', { name: 'new', description: 'new', type: 'project', body: '', supersedes: ['old', 'new', 'missing'] });
    service.save('other-project', { name: 'old', description: 'other', type: 'project', body: '' });
    expect(service.supersededByMap('project')).toEqual(new Map([['old', 'new']]));
    expect(service.supersededByMap('other-project')).toEqual(new Map());
  } finally { db.close(); }
});
