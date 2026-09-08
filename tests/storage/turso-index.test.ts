import { createClient } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { openTursoDb } from '@/lib/storage/turso-index';

const originalUrl = process.env.TURSO_DATABASE_URL;
const originalToken = process.env.TURSO_AUTH_TOKEN;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalUrl === undefined) delete process.env.TURSO_DATABASE_URL;
  else process.env.TURSO_DATABASE_URL = originalUrl;
  if (originalToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
  else process.env.TURSO_AUTH_TOKEN = originalToken;
});

test('Turso adapter はパラメータ化 query と transaction を共通 port に変換する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ltm-turso-index-'));
  roots.push(root);
  const client = createClient({ url: `file:${join(root, 'index.db')}` });
  const store = await openTursoDb({ client });
  try {
    await store.exec('CREATE TABLE values_table (id TEXT PRIMARY KEY, value TEXT)');
    await store.exec('INSERT INTO values_table (id, value) VALUES (?, ?)', ['one', 'first']);
    expect(await store.query<{ id: string; value: string }>('SELECT id, value FROM values_table WHERE id = ?', ['one']))
      .toEqual([{ id: 'one', value: 'first' }]);

    await store.transaction(async (tx) => {
      await tx.exec('INSERT INTO values_table (id, value) VALUES (?, ?)', ['two', 'second']);
    });
    expect(await store.query<{ id: string }>('SELECT id FROM values_table ORDER BY id')).toEqual([{ id: 'one' }, { id: 'two' }]);

    await expect(store.transaction(async (tx) => {
      await tx.exec('INSERT INTO values_table (id, value) VALUES (?, ?)', ['three', 'third']);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await store.query<{ id: string }>('SELECT id FROM values_table WHERE id = ?', ['three'])).toEqual([]);
  } finally {
    await store.close?.();
  }
});

test('Turso client は openTursoDb の呼び出し時まで初期化せず、env 不備を遅延検証する', async () => {
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  await expect(openTursoDb()).rejects.toThrow('TURSO_DATABASE_URL is required');
});
