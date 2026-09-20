import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

import { migrate } from '@/lib/db/migrate';
import { buildAssociativeGraph, rankMemoriesByPpr, resolveSeedEntities } from '@/lib/graph/assoc';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  for (const [id, name] of [['m1', 'one'], ['m2', 'two']]) {
    db.prepare('INSERT INTO memories (id, project_id, name, type, description, file_path, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'project', name, 'project', name, `${name}.md`, id, 'created', 'updated');
  }
  return db;
}

test('assoc graph は membership/triple/link を無向重み付きで構築し自己 loop を除く', () => {
  const db = setup();
  try {
    db.prepare('INSERT INTO entities (id, project_id, name) VALUES (?, ?, ?), (?, ?, ?)').run('e1', 'project', 'SQLite', 'e2', 'project', 'Markdown');
    db.prepare('INSERT INTO memory_entities VALUES (?, ?), (?, ?)').run('m1', 'e1', 'm2', 'e2');
    db.prepare('INSERT INTO entity_edges VALUES (?, ?, ?, ?)').run('e1', 'e2', 'indexes', 'm1');
    db.prepare('INSERT INTO entity_edges VALUES (?, ?, ?, ?)').run('e1', 'e1', 'self', 'm1');
    db.prepare('INSERT INTO links VALUES (?, ?)').run('m1', 'two');
    const graph = buildAssociativeGraph(db, 'project');
    expect(graph.adjacency.get('m1')).toEqual(expect.arrayContaining([{ to: 'ent:e1', w: 1 }, { to: 'm2', w: 2 }]));
    expect(graph.adjacency.get('ent:e1')).toEqual(expect.arrayContaining([{ to: 'm1', w: 1 }, { to: 'ent:e2', w: 1 }]));
    expect(graph.adjacency.get('ent:e1')).not.toContainEqual({ to: 'ent:e1', w: 1 });
  } finally { db.close(); }
});

test('seed は正規名と alias を大文字小文字無視で解決する', () => {
  const db = setup();
  try {
    db.prepare('INSERT INTO entities VALUES (?, ?, ?)').run('e1', 'project', 'Docker');
    db.prepare('INSERT INTO entity_aliases VALUES (?, ?, ?)').run('e1', 'container', 'm1');
    db.prepare('INSERT INTO memory_entities VALUES (?, ?)').run('m1', 'e1');
    expect(resolveSeedEntities(db, 'project', ['docker', 'CONTAINER'])).toEqual(['e1']);
    expect(rankMemoriesByPpr(db, 'project', [], ['docker']).map((item) => item.id)).toContain('m1');
  } finally { db.close(); }
});
