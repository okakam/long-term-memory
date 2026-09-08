import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { openDb } from '@/lib/db/connection';
import { MemoryConflictError } from '@/lib/memory/types';
import { MemoryService } from '@/lib/memory/service';
import { resolveStorage } from '@/lib/paths';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function createService() {
  const root = mkdtempSync(join('/tmp', 'ltm-service-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  return { root, storage, db, service: MemoryService.open(db, storage) };
}

describe('MemoryService save/get/update/forget', () => {
  test('markdown を正本として save と get を行う', () => {
    const { service, storage, db } = createService();
    try {
      const saved = service.save('project', {
        name: 'first-memory', description: 'A memory', type: 'project', body: 'Body',
        tags: ['one'], entities: [{ name: 'SQLite', aliases: [] }], triples: [],
      });
      expect(saved.id).toHaveLength(26);
      expect(readFileSync(storage.memoryFile('project', 'first-memory'), 'utf8')).toContain('name: first-memory');
      expect(service.get('project', saved.id)).toMatchObject({ id: saved.id, name: 'first-memory', body: 'Body' });
      expect(service.listSummaries('project')).toEqual([expect.objectContaining({ name: 'first-memory', body_chars: 4, tags: ['one'] })]);
    } finally { db.close(); }
  });

  test('同一 project の名前重複を拒否し、別 project では許可する', () => {
    const { service, db } = createService();
    try {
      service.save('project', { name: 'same-name', description: 'one', type: 'user', body: '' });
      expect(() => service.save('project', { name: 'same-name', description: 'two', type: 'user', body: '' })).toThrow(MemoryConflictError);
      expect(service.save('other-project', { name: 'same-name', description: 'two', type: 'user', body: '' }).name).toBe('same-name');
    } finally { db.close(); }
  });

  test('update は配列を置換し forget はファイルと index を削除する', () => {
    const { service, storage, db } = createService();
    try {
      const saved = service.save('project', { name: 'editable', description: 'old', type: 'project', body: 'old body', tags: ['old'] });
      const updated = service.update('project', 'editable', { description: 'new', body: 'new body', tags: ['new'] });
      expect(updated).toMatchObject({ description: 'new', body: 'new body', tags: ['new'] });
      expect(service.listSummaries('project')[0]).toMatchObject({ body_chars: 8, tags: ['new'] });
      service.forget('project', saved.id);
      expect(existsSync(storage.memoryFile('project', 'editable'))).toBe(false);
      expect(() => service.get('project', 'editable')).toThrow('memory not found');
    } finally { db.close(); }
  });
});
