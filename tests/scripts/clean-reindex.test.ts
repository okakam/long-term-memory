import { existsSync } from 'node:fs';
import { expect, test, vi } from 'vitest';

import { openDb } from '@/lib/db/connection';
import { MemoryService } from '@/lib/memory/service';
import { resolveStorage } from '@/lib/paths';

import { runCleanReindex } from '../../scripts/eval/clean-reindex';

// Reindex itself still runs against real copied Markdown and SQLite. Only its
// completed output is damaged, reproducing an incomplete/broken index rebuild.
test.each([
  ...['tags', 'links', 'supersedes', 'entities', 'entity_aliases', 'memory_entities', 'entity_edges', 'memories_fts']
    .map((table) => [table, `DELETE FROM ${table}`]),
  ['SQL description', "UPDATE memories SET description = 'wrong description'"],
  ['SQL content_hash', "UPDATE memories SET content_hash = 'wrong hash'"],
  ...['name', 'description', 'body'].map((column) => [
    `FTS ${column}`,
    `DELETE FROM memories_fts;
     INSERT INTO memories_fts (rowid, name, description, body)
     SELECT rowid, ${column === 'name' ? "''" : 'name'},
       ${column === 'description' ? "''" : 'description'},
       ${column === 'body' ? "''" : "CASE name WHEN 'legacy' THEN '旧記録' WHEN 'current' THEN '日本語の本文と body_chars を検証する' ELSE 'reference body' END"}
     FROM memories`,
  ]),
])('clean reindex は %s の破損を拒否して LTM_HOME と一時 store を片付ける', (_label, sql) => {
  const original = process.env.LTM_HOME;
  delete process.env.LTM_HOME;
  let targetRoot: string | undefined;
  const reindex = MemoryService.prototype.reindex;
  const spy = vi.spyOn(MemoryService.prototype, 'reindex').mockImplementation(function (this: MemoryService, projectId) {
    reindex.call(this, projectId);
    targetRoot = resolveStorage().home;
    const db = openDb(resolveStorage().indexDb);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  });
  try {
    expect(() => runCleanReindex()).toThrow(/clean reindex mismatch/);
    expect(process.env.LTM_HOME).toBeUndefined();
    expect(targetRoot).toBeDefined();
    expect(existsSync(targetRoot!)).toBe(false);
  } finally {
    spy.mockRestore();
    if (original === undefined) delete process.env.LTM_HOME;
    else process.env.LTM_HOME = original;
  }
});

test('clean reindex は copied Markdown だけから全 persisted/frontmatter 受け入れフィールドを復元し LTM_HOME を戻す', () => {
  const original = process.env.LTM_HOME;
  process.env.LTM_HOME = '/tmp/clean-reindex-original-home';
  try {
    expect(runCleanReindex()).toEqual({
      memories: 3,
      fields: ['description', 'tags', 'links', 'entities', 'triples', 'source_refs', 'body_chars', 'supersedes', 'created_at', 'updated_at'],
    });
    expect(process.env.LTM_HOME).toBe('/tmp/clean-reindex-original-home');
  } finally {
    if (original === undefined) delete process.env.LTM_HOME;
    else process.env.LTM_HOME = original;
  }
});
