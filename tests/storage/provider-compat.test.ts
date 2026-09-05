import { createClient } from '@libsql/client';
import type { IndexStore } from '@/lib/storage/contracts';
import { expect, expectTypeOf, test } from 'vitest';
import { probeFtsCompatibility } from '../../scripts/probe-turso';

interface MemoryRow {
  id: string;
  score: number;
}

const queryMemoryRows = (store: IndexStore) =>
  store.query<MemoryRow>('SELECT id, score FROM memories');

test('IndexStore.query accepts typed row interfaces', () => {
  expectTypeOf(queryMemoryRows).returns.toEqualTypeOf<Promise<MemoryRow[]>>();
});
test('local libSQL supports Japanese trigram, weighted bm25 and contentless row deletion', async () => {
  const client = createClient({ url: ':memory:' });
  try {
    await client.execute('CREATE TABLE existing_data (value TEXT)');
    await client.execute("INSERT INTO existing_data VALUES ('keep')");
    await expect(probeFtsCompatibility(client)).resolves.toEqual({ compatible: true });
    expect((await client.execute('SELECT value FROM existing_data')).rows[0].value).toBe('keep');
    expect((await client.execute("SELECT name FROM sqlite_master WHERE name LIKE 'ltm_probe_%'")).rows).toEqual([]);
  } finally { client.close(); }
});

test('failed probe removes only its own temporary table', async () => {
  const client = createClient({ url: ':memory:' });
  try {
    // 実DBに対して CREATE は通し、INSERT のみ拒否する障害注入。
    const execute = client.execute.bind(client);
    client.execute = async (statement) => {
      if (typeof statement !== 'string' && statement.sql.startsWith('INSERT')) throw new Error('injected write failure');
      return execute(statement);
    };
    await expect(probeFtsCompatibility(client)).rejects.toThrow('injected write failure');
    expect((await client.execute("SELECT name FROM sqlite_master WHERE name LIKE 'ltm_probe_%'")).rows).toEqual([]);
  } finally { client.close(); }
});
