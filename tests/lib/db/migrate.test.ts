import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

import { CURRENT_VERSION, migrate } from '@/lib/db/migrate';

function tableNames(db: Database.Database): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'shadow') AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map((row) => (row as { name: string }).name);
}

test('新規 DB に全 schema を作成し、同じ版では冪等に再適用できる', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    migrate(db);
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: CURRENT_VERSION });
    expect(tableNames(db)).toEqual(expect.arrayContaining([
      'schema_version', 'memories', 'tags', 'links', 'supersedes', 'memories_fts',
      'entities', 'entity_aliases', 'memory_entities', 'entity_edges',
    ]));
    expect(() => migrate(db)).not.toThrow();
  } finally {
    db.close();
  }
});

test('版が異なる DB は FK 安全な順序で索引を再構築する', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    migrate(db);
    db.prepare('INSERT INTO memories (id, project_id, name, type, description, file_path, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('memory-1', 'project', 'memory', 'project', 'description', 'memory.md', 'hash', 'created', 'updated');
    db.prepare('INSERT INTO tags (memory_id, tag) VALUES (?, ?)').run('memory-1', 'tag');
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_VERSION - 1);

    migrate(db);

    expect(db.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tags').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: CURRENT_VERSION });
  } finally {
    db.close();
  }
});

test('検索index再構築ではmaintenance settingsとrevision pointerを保持する', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    migrate(db);
    db.prepare('INSERT INTO maintenance_settings (project_id, enabled, review_days, session_archive_days, version) VALUES (?, ?, ?, ?, ?)')
      .run('project', 1, '{"project":90,"reference":180,"user":365,"feedback":365}', 90, 3);
    db.prepare(`INSERT INTO memory_revisions
      (project_id, memory_id, revision_id, content_key, content_hash, created_at, operation_id, reason_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('project', 'memory-1', 'revision-1', 'revision.md', 'hash', 'created', 'operation-1', 'confirmed');
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_VERSION - 1);

    migrate(db);

    expect(db.prepare('SELECT version FROM maintenance_settings WHERE project_id = ?').get('project')).toMatchObject({ version: 3 });
    expect(db.prepare('SELECT revision_id, content_key FROM memory_revisions WHERE project_id = ?').get('project'))
      .toEqual({ revision_id: 'revision-1', content_key: 'revision.md' });
  } finally {
    db.close();
  }
});

test('contentless FTS は trigram 検索・重み付き bm25・rowid DELETE を使える', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    migrate(db);
    db.prepare('INSERT INTO memories_fts (rowid, name, description, body) VALUES (?, ?, ?, ?)')
      .run(1, 'storage', '説明', '日本語の本文');
    expect(db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH '" + 'storage' + "'").all()).toEqual([{ rowid: 1 }]);
    expect(db.prepare("SELECT bm25(memories_fts, 10.0, 5.0, 1.0) AS score FROM memories_fts WHERE memories_fts MATCH 'storage'").get()).toHaveProperty('score');
    db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM memories_fts').get()).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});
