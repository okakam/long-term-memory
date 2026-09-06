import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CURRENT_VERSION } from '@/lib/db/migrate';
import { openDb } from '@/lib/db/connection';

export function runMigrationPreflight(): void {
  const root = mkdtempSync(join(tmpdir(), 'ltm-migration-preflight-'));
  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb(join(root, 'index.db'));
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined;
    if (row?.version !== CURRENT_VERSION) throw new Error('migration version mismatch');
    const table = db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'memories') as { name?: string } | undefined;
    if (table?.name !== 'memories') throw new Error('memories table missing');
    console.log('Migration preflight: PASS (' + CURRENT_VERSION + ', ' + randomUUID().slice(0, 8) + ')');
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runMigrationPreflight();
  } catch {
    console.error('Migration preflight: FAIL');
    process.exitCode = 1;
  }
}
