import { ulid } from 'ulid';
import type Database from 'better-sqlite3';

import { UnknownEntityError, type Entity, type Triple } from '@/lib/memory/types';

interface KgInput {
  entities: Entity[];
  triples: Triple[];
}

function entityId(db: Database.Database, projectId: string, name: string): string {
  const row = db.prepare('SELECT id FROM entities WHERE project_id = ? AND name = ?').get(projectId, name) as { id: string } | undefined;
  if (row) return row.id;
  const id = ulid();
  db.prepare('INSERT INTO entities (id, project_id, name) VALUES (?, ?, ?)').run(id, projectId, name);
  return id;
}

function pruneOrphanEntities(db: Database.Database, projectId: string): void {
  db.prepare('DELETE FROM entities WHERE project_id = ? AND id NOT IN (SELECT entity_id FROM memory_entities)')
    .run(projectId);
}

export function applyMemoryKg(db: Database.Database, projectId: string, memoryId: string, input: KgInput): void {
  db.prepare('DELETE FROM entity_edges WHERE asserted_by = ?').run(memoryId);
  db.prepare('DELETE FROM entity_aliases WHERE asserted_by = ?').run(memoryId);
  db.prepare('DELETE FROM memory_entities WHERE memory_id = ?').run(memoryId);

  const declaredNames = new Set(input.entities.map((entity) => entity.name));
  for (const [subject, , object] of input.triples) {
    if (!declaredNames.has(subject)) throw new UnknownEntityError(subject);
    if (!declaredNames.has(object)) throw new UnknownEntityError(object);
  }

  const ids = new Map<string, string>();
  for (const entity of input.entities) {
    const id = ids.get(entity.name) ?? entityId(db, projectId, entity.name);
    ids.set(entity.name, id);
    db.prepare('INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(memoryId, id);
    for (const alias of entity.aliases) {
      db.prepare('INSERT OR IGNORE INTO entity_aliases (entity_id, alias, asserted_by) VALUES (?, ?, ?)')
        .run(id, alias, memoryId);
    }
  }

  for (const [subject, relation, object] of input.triples) {
    db.prepare('INSERT OR IGNORE INTO entity_edges (src_entity_id, dst_entity_id, relation, asserted_by) VALUES (?, ?, ?, ?)')
      .run(ids.get(subject), ids.get(object), relation, memoryId);
  }
  pruneOrphanEntities(db, projectId);
}

export function removeMemoryKg(db: Database.Database, projectId: string, memoryId: string): void {
  db.prepare('DELETE FROM entity_edges WHERE asserted_by = ?').run(memoryId);
  db.prepare('DELETE FROM entity_aliases WHERE asserted_by = ?').run(memoryId);
  db.prepare('DELETE FROM memory_entities WHERE memory_id = ?').run(memoryId);
  pruneOrphanEntities(db, projectId);
}
