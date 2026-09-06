import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { IndexStore } from '@/lib/storage/contracts';

export const CURRENT_AUTH_VERSION = 1;

function statements(): string[] {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  return readFileSync(path, 'utf8')
    .split(/;\s*\n/)
    .map((statement) => statement.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
    .filter(Boolean);
}

function applyLocal(db: Database.Database): void {
  for (const statement of statements()) db.exec(statement);
}

export function migrateAuthLocal(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS auth_schema_version (version INTEGER PRIMARY KEY)');
  const row = db.prepare('SELECT version FROM auth_schema_version LIMIT 1').get() as { version: number } | undefined;
  const tx = db.transaction(() => {
    applyLocal(db);
    if (row) db.prepare('UPDATE auth_schema_version SET version = ?').run(CURRENT_AUTH_VERSION);
    else db.prepare('INSERT INTO auth_schema_version (version) VALUES (?)').run(CURRENT_AUTH_VERSION);
  });
  tx();
}

export async function migrateAuth(store: IndexStore): Promise<void> {
  await store.exec('CREATE TABLE IF NOT EXISTS auth_schema_version (version INTEGER PRIMARY KEY)');
  const rows = await store.query<{ version: number }>('SELECT version FROM auth_schema_version LIMIT 1');
  await store.transaction(async (tx) => {
    for (const statement of statements()) await tx.exec(statement);
    if (rows[0]) await tx.exec('UPDATE auth_schema_version SET version = ?', [CURRENT_AUTH_VERSION]);
    else await tx.exec('INSERT INTO auth_schema_version (version) VALUES (?)', [CURRENT_AUTH_VERSION]);
  });
}
