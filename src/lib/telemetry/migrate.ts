import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { IndexStore } from '@/lib/storage/contracts';

export const SCHEMA_BASE_VERSION = 2;
export const CURRENT_TELEMETRY_VERSION = 2;

function statements(): string[] {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  return readFileSync(path, 'utf8').split(/;\s*\n/)
    .map((statement) => statement.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
    .filter(Boolean);
}

function localColumns(db: Database.Database): Set<string> {
  return new Set((db.prepare('PRAGMA table_info(tool_events)').all() as Array<{ name: string }>).map((row) => row.name));
}

function migrateLocalSteps(db: Database.Database, version: number): void {
  if (version < 2) {
    const columns = localColumns(db);
    if (!columns.has('session_id')) db.exec('ALTER TABLE tool_events ADD COLUMN session_id TEXT');
    if (!columns.has('result_count')) db.exec('ALTER TABLE tool_events ADD COLUMN result_count INTEGER');
    if (!columns.has('result_chars')) db.exec('ALTER TABLE tool_events ADD COLUMN result_chars INTEGER');
    if (!columns.has('maintenance')) db.exec('ALTER TABLE tool_events ADD COLUMN maintenance INTEGER NOT NULL DEFAULT 0');
  }
}

export function migrateTelemetry(db: Database.Database): void;
export function migrateTelemetry(store: IndexStore): Promise<void>;
export function migrateTelemetry(dbOrStore: Database.Database | IndexStore): void | Promise<void> {
  if (typeof (dbOrStore as IndexStore).query === 'function') {
    const store = dbOrStore as IndexStore;
    return (async () => {
      await store.exec('CREATE TABLE IF NOT EXISTS telemetry_version (version INTEGER PRIMARY KEY)');
      const rows = await store.query<{ version: number }>('SELECT version FROM telemetry_version LIMIT 1');
      await store.transaction(async (tx) => {
        for (const statement of statements()) await tx.exec(statement);
        if (rows[0]) await tx.exec('UPDATE telemetry_version SET version = ?', [CURRENT_TELEMETRY_VERSION]);
        else await tx.exec('INSERT INTO telemetry_version (version) VALUES (?)', [CURRENT_TELEMETRY_VERSION]);
      });
    })();
  }
  const db = dbOrStore as Database.Database;
  db.exec('CREATE TABLE IF NOT EXISTS telemetry_version (version INTEGER PRIMARY KEY)');
  const row = db.prepare('SELECT version FROM telemetry_version LIMIT 1').get() as { version: number } | undefined;
  const tx = db.transaction(() => {
    if (row) migrateLocalSteps(db, row.version);
    for (const statement of statements()) db.exec(statement);
    if (row) db.prepare('UPDATE telemetry_version SET version = ?').run(CURRENT_TELEMETRY_VERSION);
    else db.prepare('INSERT INTO telemetry_version (version) VALUES (?)').run(CURRENT_TELEMETRY_VERSION);
  });
  tx();
}
