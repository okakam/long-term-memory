import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { openDb } from '@/lib/db/connection';
import { MemoryService } from '@/lib/memory/service';
import { resolveStorage } from '@/lib/paths';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('findRelated はリンクを BFS で深さ3まで辿り未解決先を無視する', () => {
  const root = mkdtempSync(join('/tmp', 'ltm-links-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  const service = MemoryService.open(db, storage);
  try {
    service.save('project', { name: 'a', description: 'a', type: 'project', body: '' });
    service.save('project', { name: 'b', description: 'b', type: 'project', body: '' });
    service.save('project', { name: 'c', description: 'c', type: 'project', body: '' });
    service.save('project', { name: 'd', description: 'd', type: 'project', body: '' });
    service.linkMemories('project', 'a', 'b');
    service.linkMemories('project', 'b', 'c');
    service.linkMemories('project', 'c', 'd');
    service.linkMemories('project', 'a', 'missing');
    expect(service.findRelated('project', 'a', 1).nodes.map((m) => m.name)).toEqual(['a', 'b']);
    expect(service.findRelated('project', 'a', 3).nodes.map((m) => m.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(service.findRelated('project', 'a', 4).truncated).toBe(true);
  } finally { db.close(); }
});
