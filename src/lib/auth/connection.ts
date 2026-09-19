import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveStorage } from '@/lib/paths';
import { resolveStorageMode } from '@/lib/storage/contracts';
import { LocalIndexStore } from '@/lib/storage/local-index';
import { migrateAuthLocal } from './migrate';
import type { IndexStore } from '@/lib/storage/contracts';

export function openLocalAuthDb(path = join(resolveStorage().home, 'auth.db')): LocalIndexStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    migrateAuthLocal(db);
    return new LocalIndexStore(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function openAuthDb(): Promise<IndexStore> {
  const mode = resolveStorageMode();
  if (mode === 'local') return openLocalAuthDb();
  throw new Error('openAuthDb is unavailable in cloud mode; use FirestoreAuthStore');
}
