import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
test('native SQLite loads and supports the required FTS options', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(body, content='', contentless_delete=1, tokenize='trigram')");
    db.prepare('INSERT INTO probe(rowid, body) VALUES (?, ?)').run(1, '長期記憶');
    expect(db.prepare('SELECT rowid FROM probe WHERE probe MATCH ?').all('長期記')).toEqual([{ rowid: 1 }]);
    db.prepare('DELETE FROM probe WHERE rowid = ?').run(1);
    expect(db.prepare('SELECT rowid FROM probe').all()).toEqual([]);
  } finally { db.close(); }
});

test('依存関係とsource treeに旧providerの移行専用資産を残さない', () => {
  const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const name of ['@clerk/nextjs', '@upstash/redis', '@vercel/blob', '@libsql/client']) {
    expect(packageJson.dependencies?.[name]).toBeUndefined();
  }
  expect(packageJson.dependencies).toMatchObject({
    '@aws-sdk/client-s3': expect.any(String),
    firebase: expect.any(String),
    'firebase-admin': expect.any(String),
  });
  expect(packageJson.devDependencies?.['@libsql/client']).toBeUndefined();
  expect(packageJson.devDependencies?.['@vercel/blob']).toBeUndefined();
  expect(existsSync(resolve(import.meta.dirname, '../scripts/migration'))).toBe(false);
  expect(existsSync(resolve(import.meta.dirname, './migration'))).toBe(false);
});
