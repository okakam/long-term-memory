import { createClient } from '@libsql/client';
import type { Client, InArgs, Transaction } from '@libsql/client';

import { migrate } from '@/lib/db/migrate';
import type { IndexStore, SqlValue } from '@/lib/storage/contracts';

type Executor = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function toArgs(args: readonly SqlValue[]): InArgs {
  return [...args];
}

async function execute(executor: Executor, sql: string, args?: readonly SqlValue[]) {
  return args === undefined ? executor.execute(sql) : executor.execute({ sql, args: toArgs(args) });
}

export class TursoIndexStore implements IndexStore {
  constructor(private readonly executor: Executor, private readonly rootClient?: Client) {}

  async exec(sql: string, args?: readonly SqlValue[]): Promise<void> {
    await execute(this.executor, sql, args);
  }

  async query<T extends object>(sql: string, args?: readonly SqlValue[]): Promise<T[]> {
    const result = await execute(this.executor, sql, args);
    return result.rows as unknown as T[];
  }

  async transaction<T>(fn: (store: IndexStore) => Promise<T>): Promise<T> {
    if (!this.rootClient) throw new Error('nested Turso transaction is not supported');
    const transaction = await this.rootClient.transaction('write');
    const store = new TursoIndexStore(transaction);
    try {
      const result = await fn(store);
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  }

  close(): void {
    this.rootClient?.close();
  }
}

export interface TursoIndexOptions {
  client?: Client;
  url?: string;
  authToken?: string;
}

export async function openTursoDb(options: TursoIndexOptions = {}): Promise<TursoIndexStore> {
  const client = options.client ?? createClient({
    url: options.url ?? requiredEnv('TURSO_DATABASE_URL'),
    authToken: options.authToken ?? requiredEnv('TURSO_AUTH_TOKEN'),
  });
  const store = new TursoIndexStore(client, client);
  await migrate(store);
  return store;
}
