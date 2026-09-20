import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '@/lib/db/connection';
import { MemoryService } from '@/lib/memory/service';
import { resolveStorage } from '@/lib/paths';
import { migrate } from '@/lib/db/migrate';
import { reconcileObjects } from '@/lib/storage/reconcile-objects';
import type { MarkdownStore, StoredObject } from '@/lib/storage/contracts';

const stores: MarkdownStore[] = [];
const roots: string[] = [];

afterEach(() => { stores.splice(0); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function createStore(objects: StoredObject[]): MarkdownStore & { removed: string[] } {
  const removed: string[] = [];
  const store: MarkdownStore & { removed: string[] } = {
    removed,
    async read() { throw new Error('not used'); },
    async write() { throw new Error('not used'); },
    async remove(key) { removed.push(key); },
    async list() { return objects; },
  };
  stores.push(store);
  return store;
}

test('reconcileObjects は参照中を残し猶予期間を過ぎた孤立 object だけを削除する', async () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    db.prepare('INSERT INTO memories (id, project_id, name, type, description, file_path, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('memory-1', 'project', 'memory', 'project', 'description', 'projects/project/memories/memory/hash.md', 'hash', 'created', 'updated');
    const old = { key: 'projects/project/memories/memory/orphan-old.md', size: 1, updatedAt: new Date('2026-01-01T00:00:00Z') };
    const fresh = { key: 'projects/project/memories/memory/orphan-new.md', size: 1, updatedAt: new Date('2026-09-05T00:00:00Z') };
    const store = createStore([old, fresh, { key: 'projects/project/memories/memory/hash.md', size: 1, updatedAt: old.updatedAt }]);
    const result = await reconcileObjects(db, store, { prefix: 'projects/project/memories/', now: new Date('2026-09-06T00:00:00Z'), graceMs: 7 * 24 * 60 * 60 * 1000 });
    expect(result.orphaned.map((object) => object.key)).toEqual([old.key]);
    expect(store.removed).toEqual([old.key]);
  } finally { db.close(); }
});


test('save は KG 失敗時に Markdown と index の両方を残さない', () => {
  const root = mkdtempSync(join('/tmp', 'ltm-atomic-save-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  const service = MemoryService.open(db, storage);
  try {
    expect(() => service.save('project', {
      name: 'invalid-kg', description: 'description', type: 'project', body: 'body',
      entities: [{ name: 'Declared', aliases: [] }], triples: [['Declared', 'relates', 'Missing']],
    })).toThrow('triple references unknown entity');
    expect(existsSync(storage.memoryFile('project', 'invalid-kg'))).toBe(false);
    expect(service.listSummaries('project')).toEqual([]);
  } finally { db.close(); }
});

test('update は DB transaction 失敗時に旧 Markdown を復元する', () => {
  const root = mkdtempSync(join('/tmp', 'ltm-atomic-update-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  const service = MemoryService.open(db, storage);
  try {
    service.save('project', { name: 'rollback', description: 'old', type: 'project', body: 'old body' });
    db.exec("CREATE TRIGGER fail_memory_update BEFORE UPDATE ON memories BEGIN SELECT RAISE(ABORT, 'injected update failure'); END");
    expect(() => service.update('project', 'rollback', { description: 'new', body: 'new body' })).toThrow('injected update failure');
    expect(readFileSync(storage.memoryFile('project', 'rollback'), 'utf8')).toContain('description: old');
    expect(service.get('project', 'rollback')).toMatchObject({ description: 'old', body: 'old body' });
  } finally { db.close(); }
});
