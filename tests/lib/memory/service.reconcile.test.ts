import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { openDb } from '@/lib/db/connection';
import { serializeMemory } from '@/lib/markdown/frontmatter';
import { MemoryService } from '@/lib/memory/service';
import type { Memory } from '@/lib/memory/types';
import { resolveStorage } from '@/lib/paths';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function memory(name: string, id: string): Memory {
  return { id, name, description: `description ${name}`, type: 'project', tags: ['tag'], links: [], entities: [], triples: [], supersedes: [], body: `body ${name}`, created_at: '2026-05-20T06:10:27.105Z', updated_at: '2026-05-20T06:10:27.105Z' };
}

test('reconcile は外部 Markdown を取り込み、編集と削除を索引へ反映する', () => {
  const root = mkdtempSync(join('/tmp', 'ltm-reconcile-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  const service = MemoryService.open(db, storage);
  try {
    const file = storage.memoryFile('project', 'external');
    mkdirSync(storage.memoriesDir('project'), { recursive: true });
    writeFileSync(file, serializeMemory(memory('external', 'external-id')));
    service.reconcile();
    expect(service.get('project', 'external')).toMatchObject({ id: 'external-id', body: 'body external' });

    writeFileSync(file, serializeMemory({ ...memory('external', 'external-id'), description: 'edited' }));
    service.reconcile();
    expect(service.listSummaries('project')[0].description).toBe('edited');

    unlinkSync(file);
    service.reconcile();
    expect(service.listSummaries('project')).toEqual([]);
  } finally { db.close(); }
});
