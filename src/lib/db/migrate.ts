import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IndexStore } from '@/lib/storage/contracts';

export const CURRENT_VERSION = 5;

export const REBUILDABLE_TABLES = [
  'entity_edges', 'entity_aliases', 'memory_entities', 'entities',
  'supersedes', 'links', 'tags', 'memories_fts', 'memories',
] as const;

type LocalDatabase = Database.Database;
type VersionRow = { version: number };

export function splitStatements(sql: string): string[] {
  return sql.split(/;\s*\n/)
    .map((statement) => statement
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim())
    .filter((statement) => statement.length > 0);
}

function schemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, 'schema.sql'), 'utf8');
}

function schemaStatements(): string[] {
  return splitStatements(schemaSql());
}

function applySchemaLocal(db: LocalDatabase): void {
  for (const statement of schemaStatements()) db.exec(statement);
}

function dropRebuildableLocal(db: LocalDatabase): void {
  for (const table of REBUILDABLE_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
}

function migrateLocal(db: LocalDatabase): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as VersionRow | undefined;
  const apply = db.transaction(() => {
    if (row && row.version !== CURRENT_VERSION) dropRebuildableLocal(db);
    applySchemaLocal(db);
    if (row) db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_VERSION);
    else db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_VERSION);
  });
  apply();
}

async function applySchemaRemote(store: IndexStore): Promise<void> {
  for (const statement of schemaStatements()) await store.exec(statement);
}

async function dropRebuildableRemote(store: IndexStore): Promise<void> {
  for (const table of REBUILDABLE_TABLES) await store.exec(`DROP TABLE IF EXISTS ${table}`);
}

async function migrateRemote(store: IndexStore): Promise<void> {
  await store.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
  const rows = await store.query<VersionRow>('SELECT version FROM schema_version LIMIT 1');
  const row = rows[0];
  await store.transaction(async (tx) => {
    if (row && row.version !== CURRENT_VERSION) await dropRebuildableRemote(tx);
    await applySchemaRemote(tx);
    if (row) await tx.exec('UPDATE schema_version SET version = ?', [CURRENT_VERSION]);
    else await tx.exec('INSERT INTO schema_version (version) VALUES (?)', [CURRENT_VERSION]);
  });
}

function isIndexStore(value: LocalDatabase | IndexStore): value is IndexStore {
  return typeof (value as IndexStore).query === 'function'
    && typeof (value as IndexStore).transaction === 'function';
}

export function migrate(db: LocalDatabase): void;
export function migrate(db: IndexStore): Promise<void>;
export function migrate(db: LocalDatabase | IndexStore): void | Promise<void> {
  return isIndexStore(db) ? migrateRemote(db) : migrateLocal(db);
}
