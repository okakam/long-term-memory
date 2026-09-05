import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';

import { computeHash } from '@/lib/markdown/file-io';
import { parseMemoryString } from '@/lib/markdown/frontmatter';
import { applyMemoryKg, removeMemoryKg } from '@/lib/memory/kg';
import type { Memory } from '@/lib/memory/types';
import { isReservedProjectId, isValidSlug } from '@/lib/slug';
import type { Storage } from '@/lib/paths';

function projectDirectories(storage: Storage): string[] {
  const root = join(storage.home, 'projects');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (isValidSlug(entry.name) || isReservedProjectId(entry.name)))
    .map((entry) => entry.name)
    .sort();
}

function memoryFiles(storage: Storage, projectId: string): string[] {
  const directory = storage.memoriesDir(projectId);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(directory, entry.name))
    .sort();
}

function insertCollections(db: Database.Database, memory: Memory): void {
  for (const tag of memory.tags) db.prepare('INSERT INTO tags (memory_id, tag) VALUES (?, ?)').run(memory.id, tag);
  for (const link of memory.links) db.prepare('INSERT INTO links (src_id, dst_name) VALUES (?, ?)').run(memory.id, link);
  for (const name of memory.supersedes) db.prepare('INSERT INTO supersedes (src_id, dst_name) VALUES (?, ?)').run(memory.id, name);
}

function insertFts(db: Database.Database, memory: Memory): void {
  db.prepare(`INSERT INTO memories_fts (rowid, name, description, body)
    VALUES ((SELECT rowid FROM memories WHERE id = ?), ?, ?, ?)`)
    .run(memory.id, memory.name, memory.description, memory.body);
}

function upsertMemory(db: Database.Database, projectId: string, filePath: string, raw: string, memory: Memory): void {
  const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(memory.id) as { id: string } | undefined;
  if (existing) {
    const fts = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(memory.id) as { rowid: number };
    db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(fts.rowid);
    removeMemoryKg(db, projectId, memory.id);
    db.prepare('DELETE FROM tags WHERE memory_id = ?').run(memory.id);
    db.prepare('DELETE FROM links WHERE src_id = ?').run(memory.id);
    db.prepare('DELETE FROM supersedes WHERE src_id = ?').run(memory.id);
    db.prepare(`UPDATE memories SET project_id = ?, name = ?, type = ?, description = ?, body_chars = ?,
      file_path = ?, content_hash = ?, created_at = ?, updated_at = ? WHERE id = ?`)
      .run(projectId, memory.name, memory.type, memory.description, [...memory.body].length, filePath,
        computeHash(raw), memory.created_at, memory.updated_at, memory.id);
  } else {
    db.prepare(`INSERT INTO memories
      (id, project_id, name, type, description, body_chars, file_path, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(memory.id, projectId, memory.name, memory.type, memory.description, [...memory.body].length,
        filePath, computeHash(raw), memory.created_at, memory.updated_at);
  }
  insertCollections(db, memory);
  insertFts(db, memory);
  applyMemoryKg(db, projectId, memory.id, { entities: memory.entities, triples: memory.triples });
}

function deleteMemoryIndex(db: Database.Database, projectId: string, memoryId: string): void {
  const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(memoryId) as { rowid: number } | undefined;
  if (row) db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(row.rowid);
  removeMemoryKg(db, projectId, memoryId);
  db.prepare('DELETE FROM tags WHERE memory_id = ?').run(memoryId);
  db.prepare('DELETE FROM links WHERE src_id = ?').run(memoryId);
  db.prepare('DELETE FROM supersedes WHERE src_id = ?').run(memoryId);
  db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
}

function savepoint<T>(db: Database.Database, name: string, fn: () => T): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

function readFileMemory(filePath: string): { raw: string; memory: Memory } | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return { raw, memory: parseMemoryString(raw) };
  } catch {
    return null;
  }
}

export function reconcile(db: Database.Database, storage: Storage): void {
  const seenIds = new Set<string>();
  const files = projectDirectories(storage).flatMap((projectId) => memoryFiles(storage, projectId).map((filePath) => ({ projectId, filePath })));
  db.exec('BEGIN');
  try {
    let savepointId = 0;
    for (const { projectId, filePath } of files) {
      const parsed = readFileMemory(filePath);
      if (!parsed) continue;
      seenIds.add(parsed.memory.id);
      try {
        savepoint(db, `reconcile_${savepointId++}`, () => upsertMemory(db, projectId, filePath, parsed.raw, parsed.memory));
      } catch {
        console.warn(`reconcile skipped ${basename(filePath)} in project ${projectId}`);
      }
    }
    const rows = db.prepare('SELECT id, project_id FROM memories').all() as Array<{ id: string; project_id: string }>;
    for (const row of rows) if (!seenIds.has(row.id)) deleteMemoryIndex(db, row.project_id, row.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function reindex(db: Database.Database, storage: Storage): void {
  db.exec('BEGIN');
  try {
    try {
      db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('delete-all')").run();
    } catch {
      db.prepare('DELETE FROM memories_fts').run();
    }
    db.prepare('DELETE FROM entity_edges').run();
    db.prepare('DELETE FROM memory_entities').run();
    db.prepare('DELETE FROM entity_aliases').run();
    db.prepare('DELETE FROM entities').run();
    db.prepare('DELETE FROM supersedes').run();
    db.prepare('DELETE FROM links').run();
    db.prepare('DELETE FROM tags').run();
    db.prepare('DELETE FROM memories').run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  reconcile(db, storage);
}
