import Database from 'better-sqlite3';

import { openDb } from '@/lib/db/connection';
import type { IndexStore, SqlValue } from '@/lib/storage/contracts';

export class LocalIndexStore implements IndexStore {
  constructor(public readonly db: Database.Database) {}

  async exec(sql: string, args: readonly SqlValue[] = []): Promise<void> {
    this.db.prepare(sql).run(...args);
  }

  async query<T extends object>(sql: string, args: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...args) as T[];
  }

  async transaction<T>(fn: (store: IndexStore) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function openLocalDb(path?: string): LocalIndexStore {
  return new LocalIndexStore(openDb(path));
}
