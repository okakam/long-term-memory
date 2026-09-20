import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

import { migrate } from '@/lib/db/migrate';
import { applyMemoryKg, removeMemoryKg } from '@/lib/memory/kg';

function dbWithMemory(id: string, projectId = 'project') {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare('INSERT INTO memories (id, project_id, name, type, description, file_path, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, projectId, `memory-${id}`, 'project', 'description', 'memory.md', 'hash', 'created', 'updated');
  return db;
}

test('applyMemoryKg は entity・alias・membership・triple provenance を作る', () => {
  const db = dbWithMemory('memory-1');
  try {
    db.transaction(() => applyMemoryKg(db, 'project', 'memory-1', {
      entities: [{ name: 'SQLite', aliases: ['sqlite3'] }, { name: 'Markdown', aliases: [] }],
      triples: [['SQLite', 'indexes', 'Markdown']],
    }))();
    expect(db.prepare('SELECT name FROM entities ORDER BY name').all()).toEqual([{ name: 'Markdown' }, { name: 'SQLite' }]);
    expect(db.prepare('SELECT alias FROM entity_aliases').all()).toEqual([{ alias: 'sqlite3' }]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_entities').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT relation FROM entity_edges').get()).toEqual({ relation: 'indexes' });
  } finally { db.close(); }
});

test('applyMemoryKg は未宣言 entity を参照する triple を拒否する', () => {
  const db = dbWithMemory('memory-1');
  try {
    expect(() => db.transaction(() => applyMemoryKg(db, 'project', 'memory-1', {
      entities: [{ name: 'SQLite', aliases: [] }],
      triples: [['SQLite', 'indexes', 'Missing']],
    }))()).toThrow('triple references unknown entity');
    expect(db.prepare('SELECT COUNT(*) AS count FROM entities').get()).toEqual({ count: 0 });
  } finally { db.close(); }
});

test('removeMemoryKg は共有主張を残し孤立 entity だけを prune する', () => {
  const db = dbWithMemory('memory-1');
  db.prepare('INSERT INTO memories (id, project_id, name, type, description, file_path, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('memory-2', 'project', 'memory-two', 'project', 'description', 'memory-two.md', 'hash', 'created', 'updated');
  try {
    db.transaction(() => applyMemoryKg(db, 'project', 'memory-1', { entities: [{ name: 'SQLite', aliases: ['db'] }], triples: [] }))();
    db.transaction(() => applyMemoryKg(db, 'project', 'memory-2', { entities: [{ name: 'SQLite', aliases: ['db'] }], triples: [] }))();
    db.transaction(() => removeMemoryKg(db, 'project', 'memory-1'))();
    expect(db.prepare('SELECT COUNT(*) AS count FROM entities').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM entity_aliases WHERE asserted_by = ?').get('memory-2')).toEqual({ count: 1 });
  } finally { db.close(); }
});
