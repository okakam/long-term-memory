import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { openLocalDb } from '@/lib/storage/local-index';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('local index は openDb の SQLite 接続を IndexStore として公開する', async () => {
  const root = mkdtempSync(join('/tmp', 'ltm-local-index-'));
  roots.push(root);
  const store = openLocalDb(join(root, 'index.db'));
  try {
    await store.exec('CREATE TABLE values_table (id TEXT PRIMARY KEY, value TEXT)');
    await store.exec('INSERT INTO values_table (id, value) VALUES (?, ?)', ['one', 'first']);
    expect(await store.query<{ id: string; value: string }>('SELECT id, value FROM values_table'))
      .toEqual([{ id: 'one', value: 'first' }]);
  } finally {
    await store.close?.();
  }
});
