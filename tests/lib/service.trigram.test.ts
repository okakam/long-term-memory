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

test('searchFulltext は日本語と ASCII の3文字以上部分文字列に一致する', () => {
  const { db, service } = createTestService();
  try {
    service.save('project', { name: 'japanese', description: 'description', type: 'project', body: '削除のパターンを確認する' });
    service.save('project', { name: 'sqlite-memory', description: 'description', type: 'project', body: 'better-sqlite3 stores data' });
    expect(service.searchFulltext('project', 'パターン').map((memory) => memory.name)).toContain('japanese');
    expect(service.searchFulltext('project', 'sqlite').map((memory) => memory.name)).toContain('sqlite-memory');
  } finally { db.close(); }
});

test('2文字 token は name/description の LIKE fallback になり本文だけの一致を返さない', () => {
  const { db, service } = createTestService();
  try {
    service.save('project', { name: 'body-only', description: 'ordinary', type: 'project', body: '削除の本文' });
    service.save('project', { name: 'description-hit', description: '削除', type: 'project', body: '' });
    expect(service.searchFulltext('project', '削除').map((memory) => memory.name)).toEqual(['description-hit']);
  } finally { db.close(); }
});
