import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';

import { openDb } from '@/lib/db/connection';
import { atomicWriteText, computeHash, readMemoryFile } from '@/lib/markdown/file-io';
import { parseMemoryString, serializeMemory } from '@/lib/markdown/frontmatter';
import { sourcesFromBody } from '@/lib/markdown/frontmatter';
import { applyMemoryKg, removeMemoryKg } from '@/lib/memory/kg';
import { withProjectLock } from '@/lib/lock/project-lock';
import { rankMemoriesByPpr } from '@/lib/graph/assoc';
import { rerank } from '@/lib/memory/rerank';
import {
  MemoryConflictError,
  MemoryNotFoundError,
  MemorySchema,
  bodyChars,
  type Memory,
  type MemorySearchResult,
  type MemorySummary,
  type SaveInput,
  type UpdateInput,
} from '@/lib/memory/types';
import { assertMemoryName, assertProjectId, SHARED_PROJECT_ID } from '@/lib/slug';
import { reconcile, reindex } from '@/lib/memory/reconcile';
import { DEFAULT_MAINTENANCE_SETTINGS, reviewSchedule } from '@/lib/maintenance/policy';
import { LocalMaintenanceStore } from '@/lib/maintenance/local-store';
import { LocalCurationStore } from '@/lib/curation/local-store';
import type { CurationStore } from '@/lib/curation/store';
import { mutationMemoryIds, mutationPayloadHash, prepareMutation } from '@/lib/maintenance/mutations';
import type { MaintenanceMemoryPage, MaintenanceMemorySource, MaintenanceStore, MutationCommitData, MutationRequest, MutationResult } from '@/lib/maintenance/store';
import type { CurationMemoryCursor, CurationSourcePage, CurationWindow } from '@/lib/curation/types';
import type { Storage } from '@/lib/paths';
import { resolveStorage } from '@/lib/paths';

interface MemoryRow {
  id: string;
  project_id: string;
  name: string;
  type: Memory['type'];
  description: string;
  body_chars: number;
  file_path: string;
  content_hash: string;
  status?: Memory['status'];
  last_reviewed_at?: string;
  next_review_at?: string;
  archived_at?: string;
  archive_reason?: string;
  archived_by?: string;
  created_at: string;
  updated_at: string;
}

interface SearchRow extends MemoryRow {
  relevance: number;
}

export interface SearchOptions {
  type?: Memory['type'];
  tags?: string[];
  limit?: number;
  queryEntities?: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  return Math.max(0, Math.floor(limit));
}

function uniqueStrings(values: string[] = []): string[] {
  return [...new Set(values)];
}

function ftsTokens(raw: string): string[] {
  return raw.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

function ftsPhrases(tokens: string[], operator: 'AND' | 'OR'): string {
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(operator === 'AND' ? ' ' : ' OR ');
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

function selectRow(db: Database.Database, projectId: string, idOrName: string): MemoryRow | undefined {
  return db.prepare(`SELECT id, project_id, name, type, description, body_chars, file_path,
    content_hash, status, created_at, updated_at FROM memories
    WHERE project_id = ? AND (id = ? OR name = ?) LIMIT 1`).get(projectId, idOrName, idOrName) as MemoryRow | undefined;
}

export class MemoryService implements MaintenanceMemorySource {
  readonly maintenanceStore: MaintenanceStore;
  readonly curationStore: CurationStore;

  private constructor(private readonly db: Database.Database, private readonly storage: Storage) {
    this.maintenanceStore = new LocalMaintenanceStore(db, storage);
    this.curationStore = new LocalCurationStore(db);
  }

  static open(db: Database.Database, storage = resolveStorage()): MemoryService {
    return new MemoryService(db, storage);
  }

  static openDefault(): MemoryService {
    const storage = resolveStorage();
    const db = openDb(storage.indexDb);
    const service = new MemoryService(db, storage);
    try {
      service.reconcile();
      return service;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private requireProject(projectId: string): string {
    return assertProjectId(projectId);
  }

  private requireName(name: string): string {
    return assertMemoryName(name);
  }

  private hydrate(row: MemoryRow): Memory {
    return readMemoryFile(row.file_path);
  }

  private summary(row: MemoryRow): MemorySummary {
    const tags = this.db.prepare('SELECT tag FROM tags WHERE memory_id = ? ORDER BY rowid').all(row.id)
      .map((item) => (item as { tag: string }).tag);
    const links = this.db.prepare('SELECT dst_name FROM links WHERE src_id = ? ORDER BY rowid').all(row.id)
      .map((item) => (item as { dst_name: string }).dst_name);
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      description: row.description,
      body_chars: row.body_chars,
      updated_at: row.updated_at,
      tags,
      links,
    };
  }

  private summaries(rows: MemoryRow[]): MemorySummary[] {
    return rows.map((row) => this.summary(row));
  }

  save(projectId: string, input: SaveInput): Memory {
    const project = this.requireProject(projectId);
    const name = this.requireName(input.name);
    if (selectRow(this.db, project, name)) throw new MemoryConflictError(name);
    const timestamp = nowIso();
    const urls = sourcesFromBody(input.body, timestamp);
    const memory = MemorySchema.parse({
      id: ulid(),
      name,
      description: input.description,
      type: input.type,
      tags: input.tags ?? [],
      links: input.links ?? [],
      entities: input.entities ?? [],
      triples: input.triples ?? [],
      source_refs: input.source_refs,
      sources: urls.length > 0 ? urls : [{ kind: 'conversation', captured_at: timestamp }],
      supersedes: input.supersedes ?? [],
      body: input.body,
      created_at: timestamp,
      updated_at: timestamp,
      ...reviewSchedule(input.type, timestamp, DEFAULT_MAINTENANCE_SETTINGS),
      status: 'active',
    });
    const text = serializeMemory(memory);
    const filePath = this.storage.memoryFile(project, name);
    atomicWriteText(filePath, text);
    try {
      const insert = this.db.transaction(() => {
        this.db.prepare(`INSERT INTO memories
          (id, project_id, name, type, description, body_chars, file_path, content_hash, status,
            last_reviewed_at, next_review_at, archived_at, archive_reason, archived_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(memory.id, project, memory.name, memory.type, memory.description, bodyChars(memory.body),
            filePath, computeHash(text), memory.status ?? 'active', memory.last_reviewed_at ?? null,
            memory.next_review_at ?? null, memory.archived_at ?? null, memory.archive_reason ?? null,
            memory.archived_by ?? null, memory.created_at, memory.updated_at);
        insertCollections(this.db, memory);
        insertFts(this.db, memory);
        applyMemoryKg(this.db, project, memory.id, { entities: memory.entities, triples: memory.triples, status: memory.status });
      });
      insert();
      return memory;
    } catch (error) {
      if (existsSync(filePath)) unlinkSync(filePath);
      throw error;
    }
  }

  get(projectId: string, idOrName: string): Memory {
    const project = this.requireProject(projectId);
    const row = selectRow(this.db, project, idOrName);
    if (!row) throw new MemoryNotFoundError(idOrName);
    return this.hydrate(row);
  }

  async listMaintenanceMemories(projectId: string, after?: string, limit = 100): Promise<MaintenanceMemoryPage> {
    const project = this.requireProject(projectId);
    const bounded = Math.min(500, Math.max(1, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT id, project_id, name, type, description, body_chars, file_path, content_hash,
      status, last_reviewed_at, next_review_at, archived_at, archive_reason, archived_by, created_at, updated_at
      FROM memories WHERE project_id = ? AND status = 'active' AND (? IS NULL OR id > ?)
      ORDER BY id ASC LIMIT ?`).all(project, after ?? null, after ?? null, bounded + 1) as MemoryRow[];
    const hasMore = rows.length > bounded;
    const pageRows = rows.slice(0, bounded);
    const items = pageRows.map((row) => {
      const raw = readFileSync(row.file_path, 'utf8');
      const memory = parseMemoryString(raw);
      if ((memory.status ?? 'active') !== 'active') throw new Error('maintenance memory status is inconsistent');
      return { memory, content_hash: computeHash(raw) };
    });
    return { items, next_after: hasMore ? pageRows[pageRows.length - 1]!.id : null };
  }

  async listCurationMemories(
    projectId: string,
    window: Pick<CurationWindow, 'from' | 'to'>,
    after: CurationMemoryCursor | null,
    limit = 25,
  ): Promise<CurationSourcePage> {
    const project = this.requireProject(projectId);
    const bounded = Math.min(25, Math.max(1, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT id, project_id, name, type, description, body_chars, file_path, content_hash,
      status, last_reviewed_at, next_review_at, archived_at, archive_reason, archived_by, created_at, updated_at
      FROM memories WHERE project_id = ? AND created_at < ? AND (? IS NULL OR created_at >= ?)
        AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all(project, window.to, window.from, window.from, after?.created_at ?? null,
        after?.created_at ?? null, after?.created_at ?? null, after?.id ?? null, bounded + 1) as MemoryRow[];
    const hasMore = rows.length > bounded;
    const pageRows = rows.slice(0, bounded);
    const items = pageRows.filter((row) => (row.status ?? 'active') === 'active').map((row) => {
      const raw = readFileSync(row.file_path, 'utf8');
      const memory = parseMemoryString(raw);
      if ((memory.status ?? 'active') !== 'active' || memory.created_at !== row.created_at) {
        throw new Error('curation memory snapshot is inconsistent');
      }
      return { memory, content_hash: computeHash(raw) };
    });
    const last = pageRows.at(-1);
    return {
      items,
      next_after: hasMore && last ? { created_at: last.created_at, id: last.id } : null,
    };
  }

  async listArchivedMaintenanceMemories(projectId: string, after?: string, limit = 100): Promise<MaintenanceMemoryPage> {
    const project = this.requireProject(projectId);
    const bounded = Math.min(500, Math.max(1, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT id, project_id, name, type, description, body_chars, file_path, content_hash,
      status, last_reviewed_at, next_review_at, archived_at, archive_reason, archived_by, created_at, updated_at
      FROM memories WHERE project_id = ? AND status = 'archived' AND (? IS NULL OR id > ?)
      ORDER BY id ASC LIMIT ?`).all(project, after ?? null, after ?? null, bounded + 1) as MemoryRow[];
    const hasMore = rows.length > bounded;
    const pageRows = rows.slice(0, bounded);
    const items = pageRows.map((row) => {
      const raw = readFileSync(row.file_path, 'utf8');
      const memory = parseMemoryString(raw);
      if (memory.status !== 'archived') throw new Error('maintenance memory status is inconsistent');
      return { memory, content_hash: computeHash(raw) };
    });
    return { items, next_after: hasMore ? pageRows[pageRows.length - 1]!.id : null };
  }

  async getMaintenanceMemory(projectId: string, memoryId: string) {
    const project = this.requireProject(projectId);
    const row = selectRow(this.db, project, memoryId);
    if (!row) return null;
    const raw = readFileSync(row.file_path, 'utf8');
    const memory = parseMemoryString(raw);
    if ((row.status ?? 'active') !== (memory.status ?? 'active')) throw new Error('maintenance memory status is inconsistent');
    return { memory, content_hash: computeHash(raw) };
  }

  async maintenanceNameExists(projectId: string, name: string): Promise<boolean> {
    const project = this.requireProject(projectId);
    return Boolean(this.db.prepare('SELECT 1 FROM memories WHERE project_id = ? AND name = ? LIMIT 1').get(project, name));
  }

  listByType(projectId: string, type: Memory['type'], limit = 100): Memory[] {
    const project = this.requireProject(projectId);
    const rows = this.db.prepare(`SELECT id, project_id, name, type, description, body_chars, file_path,
      content_hash, created_at, updated_at FROM memories WHERE project_id = ? AND type = ? AND status = 'active'
      ORDER BY updated_at DESC, name ASC LIMIT ?`).all(project, type, safeLimit(limit, 100)) as MemoryRow[];
    return rows.map((row) => this.hydrate(row));
  }

  listSummaries(projectId: string, options: { type?: Memory['type']; limit?: number } = {}): MemorySummary[] {
    const project = this.requireProject(projectId);
    const params: Array<string | number> = [project];
    let sql = `SELECT id, project_id, name, type, description, body_chars, file_path,
      content_hash, created_at, updated_at FROM memories WHERE project_id = ? AND status = 'active'`;
    if (options.type) { sql += ' AND type = ?'; params.push(options.type); }
    sql += ' ORDER BY updated_at DESC, name ASC LIMIT ?';
    params.push(safeLimit(options.limit, 100));
    return this.summaries(this.db.prepare(sql).all(...params) as MemoryRow[]);
  }

  searchByTag(projectId: string, tags: string[], match: 'any' | 'all' = 'any'): Memory[] {
    const project = this.requireProject(projectId);
    const uniqueTags = uniqueStrings(tags);
    if (uniqueTags.length === 0) return [];
    const placeholders = uniqueTags.map(() => '?').join(', ');
    const having = match === 'all' ? ` HAVING COUNT(DISTINCT t.tag) = ${uniqueTags.length}` : '';
    const rows = this.db.prepare(`SELECT m.id, m.project_id, m.name, m.type, m.description, m.body_chars,
      m.file_path, m.content_hash, m.created_at, m.updated_at FROM memories m
      JOIN tags t ON t.memory_id = m.id
      WHERE m.project_id = ? AND m.status = 'active' AND t.tag IN (${placeholders})
      GROUP BY m.id${having} ORDER BY m.updated_at DESC, m.name ASC`)
      .all(project, ...uniqueTags) as MemoryRow[];
    return rows.map((row) => this.hydrate(row));
  }

  searchByTagSummaries(projectId: string, tags: string[], match: 'any' | 'all' = 'any'): MemorySummary[] {
    const project = this.requireProject(projectId);
    const uniqueTags = uniqueStrings(tags);
    if (uniqueTags.length === 0) return [];
    const placeholders = uniqueTags.map(() => '?').join(', ');
    const having = match === 'all' ? ` HAVING COUNT(DISTINCT t.tag) = ${uniqueTags.length}` : '';
    const rows = this.db.prepare(`SELECT m.id, m.project_id, m.name, m.type, m.description, m.body_chars,
      m.file_path, m.content_hash, m.created_at, m.updated_at FROM memories m
      JOIN tags t ON t.memory_id = m.id
      WHERE m.project_id = ? AND m.status = 'active' AND t.tag IN (${placeholders})
      GROUP BY m.id${having} ORDER BY m.updated_at DESC, m.name ASC`)
      .all(project, ...uniqueTags) as MemoryRow[];
    return this.summaries(rows);
  }

  update(projectId: string, idOrName: string, patch: UpdateInput): Memory {
    const project = this.requireProject(projectId);
    const row = selectRow(this.db, project, idOrName);
    if (!row) throw new MemoryNotFoundError(idOrName);
    const filePath = row.file_path;
    const oldText = readFileSync(filePath, 'utf8');
    const current = parseMemoryString(oldText);
    const timestamp = nowIso();
    const contentChanged = (patch.body !== undefined && patch.body !== current.body)
      || (patch.description !== undefined && patch.description !== current.description);
    const review = contentChanged ? reviewSchedule(current.type, timestamp, DEFAULT_MAINTENANCE_SETTINGS) : null;
    const body = patch.body ?? current.body;
    const entities = patch.entities ?? current.entities;
    if (['user', 'feedback', 'project'].includes(current.type)
      && current.entities.length > 0 && entities.length === 0) {
      throw new Error(`cannot empty entities on a "${current.type}" memory: KG-bearing memories must keep at least one entity`);
    }
    const updated = MemorySchema.parse({
      ...current,
      description: patch.description ?? current.description,
      body: patch.body ?? current.body,
      tags: patch.tags ?? current.tags,
      links: patch.links ?? current.links,
      entities,
      triples: patch.triples ?? current.triples,
      source_refs: patch.source_refs ?? current.source_refs,
      supersedes: patch.supersedes ?? current.supersedes,
      sources: patch.body !== undefined && patch.body !== current.body
        ? (sourcesFromBody(body, timestamp).length > 0
          ? sourcesFromBody(body, timestamp)
          : [{ kind: 'conversation', captured_at: timestamp }])
        : current.sources,
      last_reviewed_at: review?.last_reviewed_at ?? current.last_reviewed_at,
      next_review_at: review?.next_review_at ?? current.next_review_at,
      status: current.status ?? 'active',
      updated_at: timestamp,
    });
    const text = serializeMemory(updated);
    atomicWriteText(filePath, text);
    try {
      const tx = this.db.transaction(() => {
        const fts = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(updated.id) as { rowid: number };
        this.db.prepare(`UPDATE memories SET description = ?, body_chars = ?, content_hash = ?, status = ?,
          last_reviewed_at = ?, next_review_at = ?, archived_at = ?, archive_reason = ?, archived_by = ?, updated_at = ?
          WHERE id = ?`).run(updated.description, bodyChars(updated.body), computeHash(text), updated.status ?? 'active',
          updated.last_reviewed_at ?? null, updated.next_review_at ?? null, updated.archived_at ?? null,
          updated.archive_reason ?? null, updated.archived_by ?? null, updated.updated_at, updated.id);
        this.db.prepare('DELETE FROM tags WHERE memory_id = ?').run(updated.id);
        this.db.prepare('DELETE FROM links WHERE src_id = ?').run(updated.id);
        this.db.prepare('DELETE FROM supersedes WHERE src_id = ?').run(updated.id);
        this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(fts.rowid);
        removeMemoryKg(this.db, project, updated.id);
        if ((updated.status ?? 'active') === 'active') {
          insertCollections(this.db, updated);
          insertFts(this.db, updated);
        }
        applyMemoryKg(this.db, project, updated.id, { entities: updated.entities, triples: updated.triples, status: updated.status });
      });
      tx();
      return updated;
    } catch (error) {
      atomicWriteText(filePath, oldText);
      throw error;
    }
  }

  forget(projectId: string, idOrName: string, reason?: string): void {
    void reason;
    const project = this.requireProject(projectId);
    const row = selectRow(this.db, project, idOrName);
    if (!row) throw new MemoryNotFoundError(idOrName);
    const revisionKeys = this.db.prepare('SELECT content_key FROM memory_revisions WHERE project_id = ? AND memory_id = ?')
      .all(project, row.id).map((item) => (item as { content_key: string }).content_key);
    if (existsSync(row.file_path)) unlinkSync(row.file_path);
    const tx = this.db.transaction(() => {
      const fts = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(row.id) as { rowid: number } | undefined;
      if (fts) this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(fts.rowid);
      removeMemoryKg(this.db, project, row.id);
      this.db.prepare('DELETE FROM tags WHERE memory_id = ?').run(row.id);
      this.db.prepare('DELETE FROM links WHERE src_id = ?').run(row.id);
      this.db.prepare('DELETE FROM supersedes WHERE src_id = ?').run(row.id);
      this.db.prepare('DELETE FROM memory_revisions WHERE project_id = ? AND memory_id = ?').run(project, row.id);
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(row.id);
    });
    tx();
    for (const key of revisionKeys) if (existsSync(key)) unlinkSync(key);
  }

  linkMemories(projectId: string, src: string, dstName: string): Memory {
    const project = this.requireProject(projectId);
    const destination = this.requireName(dstName);
    const current = this.get(project, src);
    if (current.links.includes(destination)) return current;
    return this.update(project, current.name, { links: [...current.links, destination] });
  }

  findRelated(projectId: string, idOrName: string, depth = 1): { nodes: Memory[]; truncated: boolean } {
    const project = this.requireProject(projectId);
    const start = this.db.prepare(`SELECT id, project_id, name, type, description, body_chars, file_path,
      content_hash, created_at, updated_at FROM memories WHERE project_id = ? AND status = 'active'
      AND (id = ? OR name = ?) LIMIT 1`).get(project, idOrName, idOrName) as MemoryRow | undefined;
    if (!start) throw new MemoryNotFoundError(idOrName);
    const requestedDepth = Number.isFinite(depth) ? Math.floor(depth) : 1;
    const cappedDepth = Math.min(Math.max(requestedDepth, 1), 3);
    const truncated = requestedDepth > 3;
    const rows = new Map<string, MemoryRow>([[start.id, start]]);
    const queue: Array<{ row: MemoryRow; depth: number }> = [{ row: start, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= cappedDepth) continue;
      const links = this.db.prepare(`SELECT m.id, m.project_id, m.name, m.type, m.description, m.body_chars,
        m.file_path, m.content_hash, m.created_at, m.updated_at FROM links l JOIN memories m
        ON m.project_id = ? AND m.name = l.dst_name WHERE l.src_id = ? AND m.status = 'active'
        ORDER BY m.updated_at DESC, m.name ASC`).all(project, current.row.id) as MemoryRow[];
      for (const row of links) {
        if (rows.has(row.id)) continue;
        rows.set(row.id, row);
        queue.push({ row, depth: current.depth + 1 });
      }
    }
    return { nodes: [...rows.values()].map((row) => this.hydrate(row)), truncated };
  }

  rename(projectId: string, oldName: string, newName: string): Memory {
    const project = this.requireProject(projectId);
    const old = this.requireName(oldName);
    const next = this.requireName(newName);
    const row = selectRow(this.db, project, old);
    if (!row) throw new MemoryNotFoundError(oldName);
    if (selectRow(this.db, project, next)) throw new MemoryConflictError(next);
    const oldPath = row.file_path;
    const oldText = readFileSync(oldPath, 'utf8');
    const current = parseMemoryString(oldText);
    const updated = MemorySchema.parse({ ...current, name: next, updated_at: nowIso() });
    const newPath = this.storage.memoryFile(project, next);
    const newText = serializeMemory(updated);
    atomicWriteText(newPath, newText);
    try {
      const tx = this.db.transaction(() => {
        this.db.prepare('UPDATE memories SET name = ?, file_path = ?, content_hash = ?, updated_at = ? WHERE id = ?')
          .run(next, newPath, computeHash(newText), updated.updated_at, row.id);
        this.renameReferenceRows('links', project, old, next);
        this.renameReferenceRows('supersedes', project, old, next);
        const fts = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(row.id) as { rowid: number };
        this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(fts.rowid);
        insertFts(this.db, updated);
      });
      tx();
    } catch (error) {
      if (existsSync(newPath)) unlinkSync(newPath);
      throw error;
    }
    if (existsSync(oldPath)) unlinkSync(oldPath);
    this.rewriteInboundReferences(project, old, next);
    return updated;
  }

  private renameReferenceRows(table: 'links' | 'supersedes', projectId: string, oldName: string, newName: string): void {
    this.db.prepare(`DELETE FROM ${table} AS old_row
      WHERE old_row.dst_name = ? AND old_row.src_id IN (SELECT id FROM memories WHERE project_id = ?)
      AND EXISTS (SELECT 1 FROM ${table} AS new_row WHERE new_row.src_id = old_row.src_id AND new_row.dst_name = ?)`)
      .run(oldName, projectId, newName);
    this.db.prepare(`UPDATE ${table} SET dst_name = ?
      WHERE dst_name = ? AND src_id IN (SELECT id FROM memories WHERE project_id = ?)`)
      .run(newName, oldName, projectId);
  }

  private rewriteInboundReferences(projectId: string, oldName: string, newName: string): void {
    const directory = this.storage.memoriesDir(projectId);
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === `${newName}.md`) continue;
      const path = join(directory, entry.name);
      const parsed = (() => { try { const raw = readFileSync(path, 'utf8'); return { raw, memory: parseMemoryString(raw) }; } catch { return null; } })();
      if (!parsed) continue;
      const links = parsed.memory.links.map((name) => name === oldName ? newName : name);
      const supersedes = parsed.memory.supersedes.map((name) => name === oldName ? newName : name);
      if (links.every((name, index) => name === parsed.memory.links[index])
        && supersedes.every((name, index) => name === parsed.memory.supersedes[index])) continue;
      const updated = { ...parsed.memory, links, supersedes };
      const text = serializeMemory(updated);
      atomicWriteText(path, text);
      this.db.prepare('UPDATE memories SET content_hash = ? WHERE id = ?').run(computeHash(text), parsed.memory.id);
    }
  }

  listProjects(): Array<{ id: string; count: number; updated_at: string | null; shared: boolean }> {
    return this.db.prepare(`SELECT project_id AS id, COUNT(*) AS count, MAX(updated_at) AS updated_at
      FROM memories GROUP BY project_id ORDER BY updated_at DESC, id ASC`).all()
      .map((row) => { const item = row as { id: string; count: number; updated_at: string | null }; return { ...item, shared: item.id === SHARED_PROJECT_ID }; });
  }

  private filteredMemoryRows(projectId: string, options: SearchOptions = {}): MemoryRow[] {
    const params: Array<string | number> = [projectId];
    let where = "m.project_id = ? AND m.status = 'active'";
    if (options.type) { where += ' AND m.type = ?'; params.push(options.type); }
    const tags = uniqueStrings(options.tags);
    if (tags.length > 0) {
      const placeholders = tags.map(() => '?').join(', ');
      where += ` AND EXISTS (SELECT 1 FROM tags filtered_tags WHERE filtered_tags.memory_id = m.id AND filtered_tags.tag IN (${placeholders}))`;
      params.push(...tags);
    }
    return this.db.prepare(`SELECT m.id, m.project_id, m.name, m.type, m.description, m.body_chars, m.file_path,
      m.content_hash, m.created_at, m.updated_at FROM memories m WHERE ${where}
      ORDER BY m.updated_at DESC, m.name ASC`).all(...params) as MemoryRow[];
  }

  private fulltextRows(projectId: string, query: string, options: SearchOptions = {}): SearchRow[] {
    const tokens = ftsTokens(query);
    if (tokens.length === 0) return [];
    const params: Array<string | number> = [projectId];
    let filter = "m.project_id = ? AND m.status = 'active'";
    if (options.type) { filter += ' AND m.type = ?'; params.push(options.type); }
    const tags = uniqueStrings(options.tags);
    if (tags.length > 0) {
      const placeholders = tags.map(() => '?').join(', ');
      filter += ` AND EXISTS (SELECT 1 FROM tags filtered_tags WHERE filtered_tags.memory_id = m.id AND filtered_tags.tag IN (${placeholders}))`;
      params.push(...tags);
    }
    const limit = options.limit === undefined ? undefined : safeLimit(options.limit, 20);
    const withLimit = (sql: string, values: Array<string | number>) => {
      if (limit === undefined) return this.db.prepare(sql).all(...values) as SearchRow[];
      return this.db.prepare(`${sql} LIMIT ?`).all(...values, limit) as SearchRow[];
    };
    const longTokens = tokens.filter((token) => [...token].length >= 3);
    if (longTokens.length > 0) {
      const baseSql = `SELECT m.id, m.project_id, m.name, m.type, m.description, m.body_chars, m.file_path,
        m.content_hash, m.created_at, m.updated_at, -bm25(memories_fts, 10.0, 5.0, 1.0) AS relevance
        FROM memories m JOIN memories_fts ON memories_fts.rowid = m.rowid
        WHERE ${filter} AND memories_fts MATCH ? ORDER BY relevance DESC, m.updated_at DESC`;
      const andRows = withLimit(baseSql, [...params, ftsPhrases(longTokens, 'AND')]);
      if (andRows.length > 0 || longTokens.length === 1) return andRows;
      return withLimit(baseSql, [...params, ftsPhrases(longTokens, 'OR')]);
    }
    const like = tokens.map(() => '(m.name LIKE ? COLLATE NOCASE OR m.description LIKE ? COLLATE NOCASE)').join(' OR ');
    const likeParams: Array<string | number> = [...params];
    for (const token of tokens) likeParams.push(`%${token}%`, `%${token}%`);
    const rows = withLimit(`SELECT m.id, m.project_id, m.name, m.type, m.description, m.body_chars, m.file_path,
      m.content_hash, m.created_at, m.updated_at FROM memories m WHERE ${filter} AND (${like})
      ORDER BY m.updated_at DESC, m.name ASC`, likeParams) as unknown as MemoryRow[];
    return rows.map((row, index) => ({ ...row, relevance: rows.length - index }));
  }

  private hydrateSearchRows(projectId: string, rows: SearchRow[], limit?: number): MemorySearchResult[] {
    const superseded = this.supersededByMap(projectId);
    const ranked = rerank(rows.map((row) => ({ ...row, superseded: superseded.has(row.name) })));
    return ranked.slice(0, limit === undefined ? ranked.length : limit)
      .map((row) => Object.assign(this.hydrate(row), { relevance: row.relevance }));
  }

  searchFulltext(projectId: string, query: string, options: SearchOptions = {}): MemorySearchResult[] {
    const project = this.requireProject(projectId);
    const rows = this.fulltextRows(project, query, options);
    return this.hydrateSearchRows(project, rows, options.limit === undefined ? undefined : safeLimit(options.limit, 20));
  }

  searchFulltextIds(projectId: string, query: string, options: SearchOptions = {}): Array<{ id: string; relevance: number }> {
    const project = this.requireProject(projectId);
    return this.fulltextRows(project, query, options).map((row) => ({ id: row.id, relevance: row.relevance }));
  }

  searchAssociative(projectId: string, query: string, options: SearchOptions = {}): MemorySearchResult[] {
    const project = this.requireProject(projectId);
    const queryEntities = uniqueStrings(options.queryEntities);
    if (queryEntities.length === 0) return this.searchFulltext(project, query, options);
    const limit = safeLimit(options.limit, 20);
    const pool = Math.max(limit * 5, 200);
    const ftsRows = this.fulltextRows(project, query, { ...options, limit: pool });
    const ranked = rankMemoriesByPpr(this.db, project, ftsRows.map((row) => row.id), queryEntities);
    if (ranked.length === 0) return this.hydrateSearchRows(project, ftsRows, limit);
    const candidates = new Map(this.filteredMemoryRows(project, options).map((row) => [row.id, row]));
    const rows: SearchRow[] = ranked.map((item) => {
      const row = candidates.get(item.id);
      return row ? { ...row, relevance: item.relevance } : null;
    }).filter((row): row is SearchRow => row !== null);
    if (rows.length === 0) return this.hydrateSearchRows(project, ftsRows, limit);
    return this.hydrateSearchRows(project, rows, limit);
  }

  supersededByMap(projectId: string): Map<string, string> {
    const project = this.requireProject(projectId);
    const rows = this.db.prepare(`SELECT s.dst_name AS dst, src.name AS src FROM supersedes s
      JOIN memories src ON src.id = s.src_id
      JOIN memories dst_memory ON dst_memory.project_id = src.project_id AND dst_memory.name = s.dst_name
      WHERE src.project_id = ? AND src.status = 'active' AND dst_memory.status = 'active' AND s.dst_name != src.name
      ORDER BY src.updated_at ASC, src.name ASC`).all(project) as Array<{ dst: string; src: string }>;
    return new Map(rows.map((row) => [row.dst, row.src]));
  }

  readKgGraph(projectId: string) {
    const project = this.requireProject(projectId);
    const memoryRows = this.db.prepare(`SELECT id, project_id, name, type, description, body_chars, file_path,
      content_hash, created_at, updated_at FROM memories WHERE project_id = ? AND status = 'active' ORDER BY name`).all(project) as MemoryRow[];
    const memories = this.summaries(memoryRows).map(({ id, name, type, description, tags }) => ({
      id, name, type, description, tags,
    }));
    const entities = this.db.prepare('SELECT id, name FROM entities WHERE project_id = ? ORDER BY name').all(project) as Array<{ id: string; name: string }>;
    const memberships = this.db.prepare(`SELECT me.memory_id AS memoryId, me.entity_id AS entityId FROM memory_entities me
      JOIN memories m ON m.id = me.memory_id WHERE m.project_id = ? AND m.status = 'active'`).all(project) as Array<{ memoryId: string; entityId: string }>;
    const edges = this.db.prepare(`SELECT ee.src_entity_id AS srcEntityId, ee.dst_entity_id AS dstEntityId, ee.relation
      FROM entity_edges ee JOIN entities src ON src.id = ee.src_entity_id JOIN memories asserted ON asserted.id = ee.asserted_by
      WHERE src.project_id = ? AND asserted.status = 'active'`).all(project) as Array<{ srcEntityId: string; dstEntityId: string; relation: string }>;
    const links = this.db.prepare(`SELECT l.src_id AS srcMemoryId, l.dst_name AS dstName FROM links l
      JOIN memories m ON m.id = l.src_id WHERE m.project_id = ? AND m.status = 'active'`).all(project) as Array<{ srcMemoryId: string; dstName: string }>;
    return { memories, entities, memberships, edges, links };
  }

  kgStats(projectId: string): { entities: number; edges: number; memberships: number } {
    const project = this.requireProject(projectId);
    const entities = this.db.prepare(`SELECT COUNT(*) AS count FROM entities e WHERE e.project_id = ? AND EXISTS
      (SELECT 1 FROM memory_entities me JOIN memories m ON m.id = me.memory_id WHERE me.entity_id = e.id AND m.status = 'active')`).get(project) as { count: number };
    const memberships = this.db.prepare(`SELECT COUNT(*) AS count FROM memory_entities me JOIN memories m ON m.id = me.memory_id
      WHERE m.project_id = ? AND m.status = 'active'`).get(project) as { count: number };
    const edges = this.db.prepare(`SELECT COUNT(*) AS count FROM entity_edges ee JOIN entities e ON e.id = ee.src_entity_id
      JOIN memories asserted ON asserted.id = ee.asserted_by WHERE e.project_id = ? AND asserted.status = 'active'`).get(project) as { count: number };
    return { entities: entities.count, edges: edges.count, memberships: memberships.count };
  }

  reconcile(): void {
    reconcile(this.db, this.storage);
  }

  reindex(projectId?: string): void {
    reindex(this.db, this.storage, projectId === undefined ? undefined : this.requireProject(projectId));
  }

  async applyMutationAsync(request: MutationRequest): Promise<MutationResult> {
    const project = this.requireProject(request.project_id);
    return withProjectLock(project, () => this.applyMutationUnlocked({ ...request, project_id: project }));
  }

  private async applyMutationUnlocked(request: MutationRequest): Promise<MutationResult> {
    const project = request.project_id;
    const payloadHash = mutationPayloadHash(request);
    const previousOperation = await this.maintenanceStore.checkOperation(project, request.operation_id, payloadHash);
    if (previousOperation) return previousOperation;

    const ids = mutationMemoryIds(request.action);
    const current = new Map<string, Memory>();
    const rows = new Map<string, MemoryRow>();
    const oldTexts = new Map<string, string>();
    for (const id of ids) {
      const row = selectRow(this.db, project, id);
      if (!row) {
        if (request.action.type === 'restore') throw new MemoryNotFoundError(id);
        return this.mutationConflict(request.operation_id);
      }
      const raw = readFileSync(row.file_path, 'utf8');
      const hash = computeHash(raw);
      if (request.expected_hashes[id] !== hash || row.content_hash !== hash) return this.mutationConflict(request.operation_id);
      current.set(id, parseMemoryString(raw));
      rows.set(id, row);
      oldTexts.set(id, raw);
    }
    if (Object.keys(request.expected_hashes).length !== ids.length) return this.mutationConflict(request.operation_id);
    for (const id of ids) if (!Object.hasOwn(request.expected_hashes, id)) return this.mutationConflict(request.operation_id);

    let restoredMemory: Memory | undefined;
    if (request.action.type === 'restore') {
      const restored = await this.maintenanceStore.readRevision(project, request.action.memory_id, request.action.revision_id);
      if (!restored) throw new MemoryNotFoundError(request.action.revision_id);
      restoredMemory = parseMemoryString(restored.body);
    }
    if (request.action.type === 'create') {
      const existing = selectRow(this.db, project, request.action.input.name);
      const path = this.storage.memoryFile(project, this.requireName(request.action.input.name));
      if (existing || existsSync(path)) return this.mutationConflict(request.operation_id);
    }

    const settings = await this.maintenanceStore.getSettings(project);
    if (request.expected_settings_version !== undefined
      && (settings.version !== request.expected_settings_version || !settings.enabled)) return this.mutationConflict(request.operation_id);
    if (project !== SHARED_PROJECT_ID && request.action.type !== 'restore' && request.expected_settings_version === undefined) {
      return this.mutationConflict(request.operation_id);
    }
    const afterMemories = prepareMutation(request, current, settings, restoredMemory);
    const snapshots: MutationCommitData['after'] = [];
    const revisions: MutationCommitData['revisions'] = [];
    const writtenCurrent = new Map<string, { path: string; previous?: string }>();
    const writtenRevisions: string[] = [];
    try {
      for (const memory of afterMemories) {
        const oldRow = rows.get(memory.id);
        const filePath = oldRow?.file_path ?? this.storage.memoryFile(project, this.requireName(memory.name));
        const raw = serializeMemory(memory);
        const contentHash = computeHash(raw);
        if (oldRow) {
          const revisionId = ulid();
          const revisionKey = await this.maintenanceStore.writeRevisionBody(project, memory.id, revisionId, oldTexts.get(memory.id)!);
          writtenRevisions.push(revisionKey);
          revisions.push({
            id: revisionId,
            memory_id: memory.id,
            content_key: revisionKey,
            content_hash: computeHash(oldTexts.get(memory.id)!),
            created_at: request.now,
            operation_id: request.operation_id,
            reason_code: request.reason_code,
          });
        }
        writtenCurrent.set(memory.id, { path: filePath, previous: oldRow ? oldTexts.get(memory.id) : undefined });
        atomicWriteText(filePath, raw);
        snapshots.push({ memory, content_key: filePath, content_hash: contentHash });
      }
      const result: MutationResult = {
        operation_id: request.operation_id,
        outcome: 'applied',
        memory_ids: afterMemories.map((memory) => memory.id),
        revision_ids: revisions.map((revision) => revision.id),
      };
      const data: MutationCommitData = {
        request,
        payload_hash: payloadHash,
        before_hashes: request.expected_hashes,
        after: snapshots,
        revisions,
        event: {
          operation_id: request.operation_id,
          project_id: project,
          memory_ids: result.memory_ids,
          revision_ids: result.revision_ids,
          action: request.action.type,
          reason_code: request.reason_code,
          created_at: request.now,
        },
        result,
      };
      const committed = await this.maintenanceStore.commitMutation(data, () => {
        for (const snapshot of snapshots) {
          const row = rows.get(snapshot.memory.id);
          const memory = snapshot.memory;
          if (row) {
            const fts = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(memory.id) as { rowid: number } | undefined;
            this.db.prepare(`UPDATE memories SET project_id = ?, name = ?, type = ?, description = ?, body_chars = ?,
              file_path = ?, content_hash = ?, status = ?, last_reviewed_at = ?, next_review_at = ?, archived_at = ?,
              archive_reason = ?, archived_by = ?, created_at = ?, updated_at = ? WHERE id = ?`)
              .run(project, memory.name, memory.type, memory.description, bodyChars(memory.body), snapshot.content_key,
                snapshot.content_hash, memory.status ?? 'active', memory.last_reviewed_at ?? null, memory.next_review_at ?? null,
                memory.archived_at ?? null, memory.archive_reason ?? null, memory.archived_by ?? null,
                memory.created_at, memory.updated_at, memory.id);
            if (fts) this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(fts.rowid);
            this.db.prepare('DELETE FROM tags WHERE memory_id = ?').run(memory.id);
            this.db.prepare('DELETE FROM links WHERE src_id = ?').run(memory.id);
            this.db.prepare('DELETE FROM supersedes WHERE src_id = ?').run(memory.id);
            removeMemoryKg(this.db, project, memory.id);
          } else {
            this.db.prepare(`INSERT INTO memories (id, project_id, name, type, description, body_chars, file_path,
              content_hash, status, last_reviewed_at, next_review_at, archived_at, archive_reason, archived_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(memory.id, project, memory.name, memory.type, memory.description, bodyChars(memory.body), snapshot.content_key,
                snapshot.content_hash, memory.status ?? 'active', memory.last_reviewed_at ?? null, memory.next_review_at ?? null,
                memory.archived_at ?? null, memory.archive_reason ?? null, memory.archived_by ?? null,
                memory.created_at, memory.updated_at);
          }
          if ((memory.status ?? 'active') === 'active') {
            insertCollections(this.db, memory);
            insertFts(this.db, memory);
            applyMemoryKg(this.db, project, memory.id, { entities: memory.entities, triples: memory.triples, status: 'active' });
          }
        }
      });
      if (committed.outcome === 'applied') return committed;
      this.rollbackMutationFiles(writtenCurrent, writtenRevisions);
      return committed;
    } catch (error) {
      this.rollbackMutationFiles(writtenCurrent, writtenRevisions);
      throw error;
    }
  }

  private rollbackMutationFiles(current: Map<string, { path: string; previous?: string }>, revisions: string[]): void {
    for (const entry of current.values()) {
      if (entry.previous === undefined) {
        if (existsSync(entry.path)) unlinkSync(entry.path);
      } else {
        atomicWriteText(entry.path, entry.previous);
      }
    }
    for (const path of revisions) if (existsSync(path)) unlinkSync(path);
  }

  private mutationConflict(operationId: string): MutationResult {
    return { operation_id: operationId, outcome: 'conflict', memory_ids: [], revision_ids: [] };
  }

  listRevisionsAsync(projectId: string, memoryId: string) {
    return this.maintenanceStore.listRevisions(this.requireProject(projectId), memoryId);
  }

  saveAsync(projectId: string, input: SaveInput): Promise<Memory> {
    return withProjectLock(projectId, () => this.save(projectId, input));
  }

  updateAsync(projectId: string, idOrName: string, patch: UpdateInput): Promise<Memory> {
    return withProjectLock(projectId, () => this.update(projectId, idOrName, patch));
  }

  forgetAsync(projectId: string, idOrName: string, reason?: string): Promise<void> {
    return withProjectLock(projectId, () => this.forget(projectId, idOrName, reason));
  }

  linkMemoriesAsync(projectId: string, src: string, dstName: string): Promise<Memory> {
    return withProjectLock(projectId, () => this.linkMemories(projectId, src, dstName));
  }

  renameAsync(projectId: string, oldName: string, newName: string): Promise<Memory> {
    return withProjectLock(projectId, () => this.rename(projectId, oldName, newName));
  }

  withDb<T>(fn: (db: Database.Database) => T): T {
    return fn(this.db);
  }

  close(): void {
    this.db.close();
  }
}
