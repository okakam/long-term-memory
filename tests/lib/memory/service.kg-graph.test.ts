import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { openDb } from '@/lib/db/connection';
import { MemoryService } from '@/lib/memory/service';
import { resolveStorage } from '@/lib/paths';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('readKgGraph と kgStats はプロジェクト内の memory/entity 関係だけを返す', () => {
  const root = mkdtempSync(join('/tmp', 'ltm-kg-graph-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  const service = MemoryService.open(db, storage);
  try {
    service.save('project', { name: 'memory', description: 'description', type: 'project', body: 'body', entities: [{ name: 'SQLite', aliases: [] }], triples: [] });
    service.save('other-project', { name: 'other', description: 'description', type: 'project', body: 'body', entities: [{ name: 'Other', aliases: [] }], triples: [] });
    const graph = service.readKgGraph('project');
    expect(graph.memories.map((item) => item.name)).toEqual(['memory']);
    expect(graph.entities.map((item) => item.name)).toEqual(['SQLite']);
    expect(graph.memberships).toHaveLength(1);
    expect(service.kgStats('project')).toEqual({ entities: 1, edges: 0, memberships: 1 });
  } finally { db.close(); }
});
