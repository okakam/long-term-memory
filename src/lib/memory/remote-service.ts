import { ulid } from 'ulid';

import { withProjectLock } from '@/lib/lock/project-lock';
import { computeHash } from '@/lib/markdown/file-io';
import { parseMemoryString, serializeMemory } from '@/lib/markdown/frontmatter';
import { rankMemoriesByRemotePpr } from '@/lib/graph/remote-assoc';
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
import { assertMemoryName, assertProjectId, isReservedProjectId, isValidSlug, SHARED_PROJECT_ID } from '@/lib/slug';
import { memoryObjectKey } from '@/lib/storage/blob-markdown';
import { createMarkdownStore } from '@/lib/storage/factory';
import type { IndexStore, MarkdownStore, StoredObject } from '@/lib/storage/contracts';
import { openTursoDb } from '@/lib/storage/turso-index';
import { rerank } from '@/lib/memory/rerank';

interface MemoryRow {
  id: string;
  project_id: string;
  name: string;
  type: Memory['type'];
  description: string;
  body_chars: number;
  file_path: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

interface SearchRow extends MemoryRow {
  relevance: number;
}

export interface RemoteSearchOptions {
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

async function selectRow(store: IndexStore, projectId: string, idOrName: string): Promise<MemoryRow | undefined> {
  const rows = await store.query<MemoryRow>(`SELECT id, project_id, name, type, description, body_chars, file_path,
    content_hash, created_at, updated_at FROM memories
    WHERE project_id = ? AND (id = ? OR name = ?) LIMIT 1`, [projectId, idOrName, idOrName]);
  return rows[0];
}

async function insertCollections(store: IndexStore, memory: Memory): Promise<void> {
  for (const tag of memory.tags) await store.exec('INSERT INTO tags (memory_id, tag) VALUES (?, ?)', [memory.id, tag]);
  for (const link of memory.links) await store.exec('INSERT INTO links (src_id, dst_name) VALUES (?, ?)', [memory.id, link]);
  for (const name of memory.supersedes) await store.exec('INSERT INTO supersedes (src_id, dst_name) VALUES (?, ?)', [memory.id, name]);
}

async function insertFts(store: IndexStore, memory: Memory): Promise<void> {
  await store.exec(`INSERT INTO memories_fts (rowid, name, description, body)
    VALUES ((SELECT rowid FROM memories WHERE id = ?), ?, ?, ?)`,
  [memory.id, memory.name, memory.description, memory.body]);
}

async function entityId(store: IndexStore, projectId: string, name: string): Promise<string> {
  const rows = await store.query<{ id: string }>('SELECT id FROM entities WHERE project_id = ? AND name = ?', [projectId, name]);
  if (rows[0]) return rows[0].id;
  const id = ulid();
  await store.exec('INSERT INTO entities (id, project_id, name) VALUES (?, ?, ?)', [id, projectId, name]);
  return id;
}

async function pruneOrphanEntities(store: IndexStore, projectId: string): Promise<void> {
  await store.exec('DELETE FROM entities WHERE project_id = ? AND id NOT IN (SELECT entity_id FROM memory_entities)', [projectId]);
}

async function applyMemoryKg(store: IndexStore, projectId: string, memoryId: string, memory: Memory): Promise<void> {
  await store.exec('DELETE FROM entity_edges WHERE asserted_by = ?', [memoryId]);
  await store.exec('DELETE FROM entity_aliases WHERE asserted_by = ?', [memoryId]);
  await store.exec('DELETE FROM memory_entities WHERE memory_id = ?', [memoryId]);

  const declaredNames = new Set(memory.entities.map((entity) => entity.name));
  for (const [subject, , object] of memory.triples) {
    if (!declaredNames.has(subject)) throw new Error(`triple references unknown entity (not in entities list): ${subject}`);
    if (!declaredNames.has(object)) throw new Error(`triple references unknown entity (not in entities list): ${object}`);
  }

  const ids = new Map<string, string>();
  for (const entity of memory.entities) {
    const id = ids.get(entity.name) ?? await entityId(store, projectId, entity.name);
    ids.set(entity.name, id);
    await store.exec('INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)', [memoryId, id]);
    for (const alias of entity.aliases) {
      await store.exec('INSERT OR IGNORE INTO entity_aliases (entity_id, alias, asserted_by) VALUES (?, ?, ?)', [id, alias, memoryId]);
    }
  }
  for (const [subject, relation, object] of memory.triples) {
    await store.exec('INSERT OR IGNORE INTO entity_edges (src_entity_id, dst_entity_id, relation, asserted_by) VALUES (?, ?, ?, ?)', [
      ids.get(subject)!, ids.get(object)!, relation, memoryId,
    ]);
  }
  await pruneOrphanEntities(store, projectId);
}

async function insertMemoryIndex(store: IndexStore, projectId: string, key: string, raw: string, memory: Memory): Promise<void> {
  const contentHash = computeHash(raw);
  await store.exec(`INSERT INTO memories
    (id, project_id, name, type, description, body_chars, file_path, content_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [memory.id, projectId, memory.name, memory.type, memory.description,
    bodyChars(memory.body), key, contentHash, memory.created_at, memory.updated_at]);
  await insertCollections(store, memory);
  await insertFts(store, memory);
  await applyMemoryKg(store, projectId, memory.id, memory);
}

async function deleteIndex(store: IndexStore, projectId: string, memoryId: string): Promise<void> {
  const rows = await store.query<{ rowid: number }>('SELECT rowid FROM memories WHERE id = ?', [memoryId]);
  if (rows[0]) await store.exec('DELETE FROM memories_fts WHERE rowid = ?', [rows[0].rowid]);
  await store.exec('DELETE FROM entity_edges WHERE asserted_by = ?', [memoryId]);
  await store.exec('DELETE FROM entity_aliases WHERE asserted_by = ?', [memoryId]);
  await store.exec('DELETE FROM memory_entities WHERE memory_id = ?', [memoryId]);
  await pruneOrphanEntities(store, projectId);
  await store.exec('DELETE FROM tags WHERE memory_id = ?', [memoryId]);
  await store.exec('DELETE FROM links WHERE src_id = ?', [memoryId]);
  await store.exec('DELETE FROM supersedes WHERE src_id = ?', [memoryId]);
  await store.exec('DELETE FROM memories WHERE id = ?', [memoryId]);
}

export class RemoteMemoryService {
  private closed = false;

  constructor(
    private readonly indexPromise: Promise<IndexStore>,
    private readonly markdown: MarkdownStore = createMarkdownStore({ mode: 'vercel' }),
  ) {}

  static openDefault(): RemoteMemoryService {
    return new RemoteMemoryService(openTursoDb());
  }

  private async index(): Promise<IndexStore> {
    if (this.closed) throw new Error('memory service is closed');
    return this.indexPromise;
  }

  private requireProject(projectId: string): string {
    return assertProjectId(projectId);
  }

  private requireName(name: string): string {
    return assertMemoryName(name);
  }

  private async hydrate(row: MemoryRow): Promise<Memory> {
    return parseMemoryString(await this.markdown.read(row.file_path));
  }

  private async summary(store: IndexStore, row: MemoryRow): Promise<MemorySummary> {
    const [tags, links] = await Promise.all([
      store.query<{ tag: string }>('SELECT tag FROM tags WHERE memory_id = ? ORDER BY rowid', [row.id]),
      store.query<{ dst_name: string }>('SELECT dst_name FROM links WHERE src_id = ? ORDER BY rowid', [row.id]),
    ]);
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      description: row.description,
      body_chars: Number(row.body_chars),
      updated_at: row.updated_at,
      tags: tags.map((item) => item.tag),
      links: links.map((item) => item.dst_name),
    };
  }

  private async summaries(store: IndexStore, rows: MemoryRow[]): Promise<MemorySummary[]> {
    return Promise.all(rows.map((row) => this.summary(store, row)));
  }

  async save(projectId: string, input: SaveInput): Promise<Memory> {
    const project = this.requireProject(projectId);
    const name = this.requireName(input.name);
    const store = await this.index();
    if (await selectRow(store, project, name)) throw new MemoryConflictError(name);
    const timestamp = nowIso();
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
      supersedes: input.supersedes ?? [],
      body: input.body,
      created_at: timestamp,
      updated_at: timestamp,
    });
    const text = serializeMemory(memory);
    const contentHash = computeHash(text);
    const key = memoryObjectKey(project, name, contentHash);
    await this.markdown.write(key, text);
    try {
      await store.transaction(async (tx) => {
        if (await selectRow(tx, project, name)) throw new MemoryConflictError(name);
        await insertMemoryIndex(tx, project, key, text, memory);
      });
      return memory;
    } catch (error) {
      await this.markdown.remove(key).catch(() => undefined);
      throw error;
    }
  }

  async get(projectId: string, idOrName: string): Promise<Memory> {
    const project = this.requireProject(projectId);
    const row = await selectRow(await this.index(), project, idOrName);
    if (!row) throw new MemoryNotFoundError(idOrName);
    return this.hydrate(row);
  }

  async listByType(projectId: string, type: Memory['type'], limit = 100): Promise<Memory[]> {
    const project = this.requireProject(projectId);
    const rows = await (await this.index()).query<MemoryRow>(`SELECT id, project_id, name, type, description, body_chars, file_path,
      content_hash, created_at, updated_at FROM memories WHERE project_id = ? AND type = ?
      ORDER BY updated_at DESC, name ASC LIMIT ?`, [project, type, safeLimit(limit, 100)]);
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  async listSummaries(projectId: string, options: { type?: Memory['type']; limit?: number } = {}): Promise<MemorySummary[]> {
    const project = this.requireProject(projectId);
    const params: Array<string | number> = [project];
    let sql = `SELECT id, project_id, name, type, description, body_chars, file_path,
      content_hash, created_at, updated_at FROM memories WHERE project_id = ?`;
    if (options.type) { sql += ' AND type = ?'; params.push(options.type); }
    sql += ' ORDER BY updated_at DESC, name ASC LIMIT ?';
    params.push(safeLimit(options.limit, 100));
    const store = await this.index();
    return this.summaries(store, await store.query<MemoryRow>(sql, params));
  }

  async searchByTag(projectId: string, tags: string[], match: 'any' | 'all' = 'any'): Promise<Memory[]> {
    const summaries = await this.searchByTagSummaries(projectId, tags, match);
    return Promise.all(summaries.map((summary) => this.get(projectId, summary.id)));
  }

  async searchByTagSummaries(projectId: string, tags: string[], match: 'any' | 'all' = 'any'): Promise<MemorySummary[]> {
    const project = this.requireProject(projectId);
    const uniqueTags = uniqueStrings(tags);
    if (uniqueTags.length === 0) return [];
    const placeholders = uniqueTags.map(() => '?').join(', ');
    const having = match === 'all' ? ` HAVING COUNT(DISTINCT t.tag) = ${uniqueTags.length}` : '';
    const store = await this.index();
    const rows = await store.query<MemoryRow>(`SELECT m.id, m.project_id, m.name, m.type, m.description, m.body_chars,
      m.file_path, m.content_hash, m.created_at, m.updated_at FROM memories m
      JOIN tags t ON t.memory_id = m.id
      WHERE m.project_id = ? AND t.tag IN (${placeholders})
      GROUP BY m.id${having} ORDER BY m.updated_at DESC, m.name ASC`, [project, ...uniqueTags]);
    return this.summaries(store, rows);
  }

  async findRelated(projectId: string, idOrName: string, depth = 1): Promise<{ nodes: Memory[]; truncated: boolean }> {
    const project = this.requireProject(projectId);
    const store = await this.index();
    const start = await selectRow(store, project, idOrName);
    if (!start) throw new MemoryNotFoundError(idOrName);
    const requestedDepth = Number.isFinite(depth) ? Math.floor(depth) : 1;
    const cappedDepth = Math.min(Math.max(requestedDepth, 1), 3);
    const rows = new Map<string, MemoryRow>([[start.id, start]]);
    const queue: Array<{ row: MemoryRow; depth: number }> = [{ row: start, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= cappedDepth) continue;
      const links = await store.query<MemoryRow>(`SELECT m.id, m.project_id, m.name, m.type, m.description, m.body_chars,
        m.file_path, m.content_hash, m.created_at, m.updated_at FROM links l JOIN memories m
        ON m.project_id = ? AND m.name = l.dst_name WHERE l.src_id = ?
        ORDER BY m.updated_at DESC, m.name ASC`, [project, current.row.id]);
      for (const row of links) {
        if (rows.has(row.id)) continue;
        rows.set(row.id, row);
        queue.push({ row, depth: current.depth + 1 });
      }
    }
    return {
      nodes: await Promise.all([...rows.values()].map((row) => this.hydrate(row))),
      truncated: requestedDepth > 3,
    };
  }

  async update(projectId: string, idOrName: string, patch: UpdateInput): Promise<Memory> {
    const project = this.requireProject(projectId);
    const store = await this.index();
    const row = await selectRow(store, project, idOrName);
    if (!row) throw new MemoryNotFoundError(idOrName);
    const current = parseMemoryString(await this.markdown.read(row.file_path));
    const entities = patch.entities ?? current.entities;
    if (['user', 'feedback', 'project'].includes(current.type) && current.entities.length > 0 && entities.length === 0) {
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
      updated_at: nowIso(),
    });
    const text = serializeMemory(updated);
    const contentHash = computeHash(text);
    const key = memoryObjectKey(project, updated.name, contentHash);
    await this.markdown.write(key, text);
    try {
      await store.transaction(async (tx) => {
        const currentRow = await selectRow(tx, project, idOrName);
        if (!currentRow) throw new MemoryNotFoundError(idOrName);
        const fts = await tx.query<{ rowid: number }>('SELECT rowid FROM memories WHERE id = ?', [updated.id]);
        await tx.exec('UPDATE memories SET description = ?, body_chars = ?, file_path = ?, content_hash = ?, updated_at = ? WHERE id = ?', [
          updated.description, bodyChars(updated.body), key, contentHash, updated.updated_at, updated.id,
        ]);
        await tx.exec('DELETE FROM tags WHERE memory_id = ?', [updated.id]);
        await tx.exec('DELETE FROM links WHERE src_id = ?', [updated.id]);
        await tx.exec('DELETE FROM supersedes WHERE src_id = ?', [updated.id]);
        if (fts[0]) await tx.exec('DELETE FROM memories_fts WHERE rowid = ?', [fts[0].rowid]);
        await applyMemoryKg(tx, project, updated.id, updated);
        await insertCollections(tx, updated);
        await insertFts(tx, updated);
      });
    } catch (error) {
      await this.markdown.remove(key).catch(() => undefined);
      throw error;
    }
    if (key !== row.file_path) await this.markdown.remove(row.file_path).catch(() => undefined);
    return updated;
  }

  async forget(projectId: string, idOrName: string, reason?: string): Promise<void> {
    void reason;
    const project = this.requireProject(projectId);
    const store = await this.index();
    const row = await selectRow(store, project, idOrName);
    if (!row) throw new MemoryNotFoundError(idOrName);
    await store.transaction((tx) => deleteIndex(tx, project, row.id));
    await this.markdown.remove(row.file_path).catch(() => undefined);
  }

  async linkMemories(projectId: string, src: string, dstName: string): Promise<Memory> {
    const project = this.requireProject(projectId);
    const destination = this.requireName(dstName);
    const current = await this.get(project, src);
    if (current.links.includes(destination)) return current;
    return this.update(project, current.name, { links: [...current.links, destination] });
  }

  async listProjects(): Promise<Array<{ id: string; count: number; updated_at: string | null; shared: boolean }>> {
    const rows = await (await this.index()).query<{ id: string; count: number; updated_at: string | null }>(`SELECT project_id AS id,
      COUNT(*) AS count, MAX(updated_at) AS updated_at FROM memories GROUP BY project_id ORDER BY updated_at DESC, id ASC`);
    return rows.map((row) => ({ id: row.id, count: Number(row.count), updated_at: row.updated_at, shared: row.id === SHARED_PROJECT_ID }));
  }

  private async filteredMemoryRows(projectId: string, options: RemoteSearchOptions = {}): Promise<MemoryRow[]> {
    const params: Array<string | number> = [projectId];
    let where = 'm.project_id = ?';
    if (options.type) { where += ' AND m.type = ?'; params.push(options.type); }
    const tags = uniqueStrings(options.tags);
    if (tags.length > 0) {
      const placeholders = tags.map(() => '?').join(', ');
      where += ` AND EXISTS (SELECT 1 FROM tags filtered_tags WHERE filtered_tags.memory_id = m.id AND filtered_tags.tag IN (${placeholders}))`;
      params.push(...tags);
    }
    return (await (await this.index()).query<MemoryRow>(`SELECT m.id, m.project_id, m.name, m.type, m.description, m.body_chars,
      m.file_path, m.content_hash, m.created_at, m.updated_at FROM memories m WHERE ${where}
      ORDER BY m.updated_at DESC, m.name ASC`, params));
  }

  private async fulltextRows(projectId: string, query: string, options: RemoteSearchOptions = {}): Promise<SearchRow[]> {
    const tokens = ftsTokens(query);
    if (tokens.length === 0) return [];
    const params: Array<string | number> = [projectId];
    let filter = 'm.project_id = ?';
    if (options.type) { filter += ' AND m.type = ?'; params.push(options.type); }
    const tags = uniqueStrings(options.tags);
    if (tags.length > 0) {
      const placeholders = tags.map(() => '?').join(', ');
      filter += ` AND EXISTS (SELECT 1 FROM tags filtered_tags WHERE filtered_tags.memory_id = m.id AND filtered_tags.tag IN (${placeholders}))`;
      params.push(...tags);
    }
    const limit = options.limit === undefined ? undefined : safeLimit(options.limit, 20);
    const store = await this.index();
    const withLimit = async (sql: string, values: Array<string | number>): Promise<SearchRow[]> => {
      const statement = limit === undefined ? sql : `${sql} LIMIT ?`;
      return store.query<SearchRow>(statement, limit === undefined ? values : [...values, limit]);
    };
    const longTokens = tokens.filter((token) => [...token].length >= 3);
    if (longTokens.length > 0) {
      const baseSql = `SELECT m.id, m.project_id, m.name, m.type, m.description, m.body_chars, m.file_path,
        m.content_hash, m.created_at, m.updated_at, -bm25(memories_fts, 10.0, 5.0, 1.0) AS relevance
        FROM memories m JOIN memories_fts ON memories_fts.rowid = m.rowid
        WHERE ${filter} AND memories_fts MATCH ? ORDER BY relevance DESC, m.updated_at DESC`;
      const andRows = await withLimit(baseSql, [...params, ftsPhrases(longTokens, 'AND')]);
      if (andRows.length > 0 || longTokens.length === 1) return andRows;
      return withLimit(baseSql, [...params, ftsPhrases(longTokens, 'OR')]);
    }
    const like = tokens.map(() => '(m.name LIKE ? COLLATE NOCASE OR m.description LIKE ? COLLATE NOCASE)').join(' OR ');
    const likeParams: Array<string | number> = [...params];
    for (const token of tokens) likeParams.push(`%${token}%`, `%${token}%`);
    const rows = await withLimit(`SELECT m.id, m.project_id, m.name, m.type, m.description, m.body_chars, m.file_path,
      m.content_hash, m.created_at, m.updated_at FROM memories m WHERE ${filter} AND (${like})
      ORDER BY m.updated_at DESC, m.name ASC`, likeParams);
    return rows.map((row, index) => ({ ...row, relevance: rows.length - index }));
  }

  private async supersededByMapFor(store: IndexStore, projectId: string): Promise<Map<string, string>> {
    const rows = await store.query<{ dst: string; src: string }>(`SELECT s.dst_name AS dst, src.name AS src FROM supersedes s
      JOIN memories src ON src.id = s.src_id JOIN memories dst_memory ON dst_memory.project_id = src.project_id AND dst_memory.name = s.dst_name
      WHERE src.project_id = ? AND s.dst_name != src.name ORDER BY src.updated_at ASC, src.name ASC`, [projectId]);
    return new Map(rows.map((row) => [row.dst, row.src]));
  }

  private async hydrateSearchRows(projectId: string, rows: SearchRow[], limit?: number): Promise<MemorySearchResult[]> {
    const store = await this.index();
    const superseded = await this.supersededByMapFor(store, projectId);
    const ranked = rerank(rows.map((row) => ({ ...row, superseded: superseded.has(row.name), relevance: Number(row.relevance) })));
    return Promise.all(ranked.slice(0, limit === undefined ? ranked.length : limit).map(async (row) =>
      Object.assign(await this.hydrate(row), { relevance: Number(row.relevance) })));
  }

  async searchFulltext(projectId: string, query: string, options: RemoteSearchOptions = {}): Promise<MemorySearchResult[]> {
    const project = this.requireProject(projectId);
    const rows = await this.fulltextRows(project, query, options);
    return this.hydrateSearchRows(project, rows, options.limit === undefined ? undefined : safeLimit(options.limit, 20));
  }

  async searchFulltextIds(projectId: string, query: string, options: RemoteSearchOptions = {}): Promise<Array<{ id: string; relevance: number }>> {
    const project = this.requireProject(projectId);
    return (await this.fulltextRows(project, query, options)).map((row) => ({ id: row.id, relevance: Number(row.relevance) }));
  }

  async searchAssociative(projectId: string, query: string, options: RemoteSearchOptions = {}): Promise<MemorySearchResult[]> {
    const project = this.requireProject(projectId);
    const queryEntities = uniqueStrings(options.queryEntities);
    if (queryEntities.length === 0) return this.searchFulltext(project, query, options);
    const limit = safeLimit(options.limit, 20);
    const ftsRows = await this.fulltextRows(project, query, { ...options, limit: Math.max(limit * 5, 200) });
    const ranked = await rankMemoriesByRemotePpr(await this.index(), project, ftsRows.map((row) => row.id), queryEntities);
    if (ranked.length === 0) return this.hydrateSearchRows(project, ftsRows, limit);
    const candidates = new Map((await this.filteredMemoryRows(project, options)).map((row) => [row.id, row]));
    const rows = ranked.map((item) => {
      const row = candidates.get(item.id);
      return row ? { ...row, relevance: item.relevance } : null;
    }).filter((row): row is SearchRow => row !== null);
    return rows.length === 0 ? this.hydrateSearchRows(project, ftsRows, limit) : this.hydrateSearchRows(project, rows, limit);
  }

  async supersededByMap(projectId: string): Promise<Map<string, string>> {
    return this.supersededByMapFor(await this.index(), this.requireProject(projectId));
  }

  async readKgGraph(projectId: string) {
    const project = this.requireProject(projectId);
    const store = await this.index();
    const memoryRows = await store.query<MemoryRow>(`SELECT id, project_id, name, type, description, body_chars, file_path,
      content_hash, created_at, updated_at FROM memories WHERE project_id = ? ORDER BY name`, [project]);
    const summaries = await this.summaries(store, memoryRows);
    const memories = summaries.map(({ id, name, type, description, tags }) => ({ id, name, type, description, tags }));
    const entities = await store.query<{ id: string; name: string }>('SELECT id, name FROM entities WHERE project_id = ? ORDER BY name', [project]);
    const memberships = await store.query<{ memoryId: string; entityId: string }>(`SELECT me.memory_id AS memoryId, me.entity_id AS entityId
      FROM memory_entities me JOIN memories m ON m.id = me.memory_id WHERE m.project_id = ?`, [project]);
    const edges = await store.query<{ srcEntityId: string; dstEntityId: string; relation: string }>(`SELECT ee.src_entity_id AS srcEntityId,
      ee.dst_entity_id AS dstEntityId, ee.relation FROM entity_edges ee JOIN entities src ON src.id = ee.src_entity_id WHERE src.project_id = ?`, [project]);
    const links = await store.query<{ srcMemoryId: string; dstName: string }>(`SELECT l.src_id AS srcMemoryId, l.dst_name AS dstName
      FROM links l JOIN memories m ON m.id = l.src_id WHERE m.project_id = ?`, [project]);
    return { memories, entities, memberships, edges, links };
  }

  async kgStats(projectId: string): Promise<{ entities: number; edges: number; memberships: number }> {
    const project = this.requireProject(projectId);
    const store = await this.index();
    const [entities, memberships, edges] = await Promise.all([
      store.query<{ count: number }>('SELECT COUNT(*) AS count FROM entities WHERE project_id = ?', [project]),
      store.query<{ count: number }>('SELECT COUNT(*) AS count FROM memory_entities me JOIN memories m ON m.id = me.memory_id WHERE m.project_id = ?', [project]),
      store.query<{ count: number }>('SELECT COUNT(*) AS count FROM entity_edges ee JOIN entities e ON e.id = ee.src_entity_id WHERE e.project_id = ?', [project]),
    ]);
    return { entities: Number(entities[0]?.count ?? 0), edges: Number(edges[0]?.count ?? 0), memberships: Number(memberships[0]?.count ?? 0) };
  }

  async reconcile(): Promise<void> {
    await this.index();
  }

  async reindex(): Promise<void> {
    const store = await this.index();
    const objects = await this.markdown.list('');
    const snapshots = new Map<string, { projectId: string; object: StoredObject; raw: string; memory: Memory }>();
    for (const object of objects) {
      const marker = '/memories/';
      const markerIndex = object.key.lastIndexOf(marker);
      if (markerIndex < 1) continue;
      const prefix = object.key.slice(0, markerIndex);
      const projectId = prefix.slice(prefix.lastIndexOf('/') + 1);
      if (!isValidSlug(projectId) && !isReservedProjectId(projectId)) continue;
      try {
        const raw = await this.markdown.read(object.key);
        const memory = parseMemoryString(raw);
        const key = `${projectId}:${memory.name}`;
        const previous = snapshots.get(key);
        if (!previous || previous.object.updatedAt.getTime() <= object.updatedAt.getTime()) {
          snapshots.set(key, { projectId, object, raw, memory });
        }
      } catch {
        // Reindex follows local reconcile semantics: malformed objects are skipped.
      }
    }
    await store.transaction(async (tx) => {
      try { await tx.exec("INSERT INTO memories_fts(memories_fts) VALUES('delete-all')"); } catch { await tx.exec('DELETE FROM memories_fts'); }
      for (const table of ['entity_edges', 'entity_aliases', 'memory_entities', 'entities', 'supersedes', 'links', 'tags', 'memories']) {
        await tx.exec(`DELETE FROM ${table}`);
      }
      for (const snapshot of snapshots.values()) {
        await insertMemoryIndex(tx, snapshot.projectId, snapshot.object.key, snapshot.raw, snapshot.memory);
      }
    });
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

  close(): void {
    this.closed = true;
    void this.indexPromise.then((store) => store.close?.()).catch(() => undefined);
  }
}
