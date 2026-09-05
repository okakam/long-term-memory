import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

import { REBUILDABLE_TABLES } from '@/lib/db/migrate';

const schema = readFileSync(resolve(process.cwd(), 'src/lib/db/schema.sql'), 'utf8');
const declaredTables = [...schema.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)/gi)]
  .map((match) => match[1]);

test('schema.sql の全テーブルと仮想テーブルを再構築対象へ列挙する', () => {
  expect(new Set(REBUILDABLE_TABLES)).toEqual(new Set(declaredTables.filter((name) => name !== 'schema_version')));
  expect(REBUILDABLE_TABLES).toEqual([
    'entity_edges',
    'entity_aliases',
    'memory_entities',
    'entities',
    'supersedes',
    'links',
    'tags',
    'memories_fts',
    'memories',
  ]);
});

test('schema.sql は contentless trigram FTS と schema_version を宣言する', () => {
  expect(schema).toContain("content='', contentless_delete=1, tokenize='trigram'");
  expect(schema).toContain('CREATE TABLE IF NOT EXISTS schema_version');
});
