import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { openDb } from '@/lib/db/connection';
import { MemoryConflictError } from '@/lib/memory/types';
import { MemoryService } from '@/lib/memory/service';
import { resolveStorage } from '@/lib/paths';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createService() {
  const root = mkdtempSync(join('/tmp', 'ltm-service-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  return { root, storage, db, service: MemoryService.open(db, storage) };
}

describe('MemoryService save/get/update/forget', () => {
  test('save は出典と種別別の初回見直し日を記録し、本文更新だけで期限を更新する', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    const { service, db } = createService();
    try {
      const saved = service.save('project', {
        name: 'reviewable-note', description: 'A memory', type: 'project', body: 'Body',
      });
      expect(saved).toMatchObject({
        status: 'active',
        sources: [{ kind: 'conversation', captured_at: '2026-10-01T00:00:00.000Z' }],
        last_reviewed_at: '2026-10-01T00:00:00.000Z',
        next_review_at: '2026-12-30T00:00:00.000Z',
      });

      vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
      const tagged = service.update('project', saved.id, { tags: ['changed'] });
      expect(tagged.last_reviewed_at).toBe('2026-10-01T00:00:00.000Z');
      expect(tagged.next_review_at).toBe('2026-12-30T00:00:00.000Z');

      vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'));
      const edited = service.update('project', saved.id, { body: 'Updated body' });
      expect(edited.last_reviewed_at).toBe('2026-10-03T00:00:00.000Z');
      expect(edited.next_review_at).toBe('2027-01-01T00:00:00.000Z');
    } finally { db.close(); }
  });

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
