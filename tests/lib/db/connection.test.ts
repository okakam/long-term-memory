import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';

import { openDb } from '@/lib/db/connection';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('openDb は親ディレクトリを作成し WAL と foreign_keys を有効にする', () => {
  const root = mkdtempSync(join(tmpdir(), 'ltm-db-'));
  roots.push(root);
  const path = join(root, 'nested', 'index.db');
  const db = openDb(path);
  try {
    expect(existsSync(path)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  } finally {
    db.close();
  }
});
