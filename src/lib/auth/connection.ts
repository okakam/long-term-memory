import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createClient, type Client } from '@libsql/client';

import { resolveStorage } from '@/lib/paths';
import { resolveStorageMode } from '@/lib/storage/contracts';
import { LocalIndexStore } from '@/lib/storage/local-index';
import { TursoIndexStore } from '@/lib/storage/turso-index';
import { migrateAuth, migrateAuthLocal } from './migrate';
import type { IndexStore } from '@/lib/storage/contracts';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

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
  const mode = process.env.LTM_STORAGE_DRIVER ? resolveStorageMode() : (process.env.VERCEL === '1' ? 'vercel' : 'local');
  if (mode === 'local') return openLocalAuthDb();
  const client: Client = createClient({
    url: requiredEnv('TURSO_AUTH_DATABASE_URL'),
    authToken: requiredEnv('TURSO_AUTH_DATABASE_TOKEN'),
  });
  const store = new TursoIndexStore(client, client);
  try {
    await migrateAuth(store);
    return store;
  } catch (error) {
    store.close();
    throw error;
  }
}
