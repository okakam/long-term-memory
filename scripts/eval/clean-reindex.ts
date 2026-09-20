import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { openDb } from '@/lib/db/connection';
import { parseMemoryString } from '@/lib/markdown/frontmatter';
import { MemoryService } from '@/lib/memory/service';
import { resolveStorage, type Storage } from '@/lib/paths';

const PROJECT_ID = 'acceptance';
const FIELDS = ['description', 'tags', 'links', 'entities', 'triples', 'source_refs', 'body_chars', 'supersedes', 'created_at', 'updated_at'] as const;

function markdownSnapshot(storage: Storage) {
  return readdirSync(storage.memoriesDir(PROJECT_ID)).filter((name) => name.endsWith('.md')).sort().map((file) => {
    const raw = readFileSync(join(storage.memoriesDir(PROJECT_ID), file), 'utf8');
    return { file, raw, memory: parseMemoryString(raw) };
  });
}

function compareRows(label: string, actual: unknown[], expected: unknown[]) {
  const sorted = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).sort();
  if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected))) {
    throw new Error(`clean reindex mismatch: ${label}`);
  }
}

function verifyIndex(db: ReturnType<typeof openDb>, storage: Storage, documents: ReturnType<typeof markdownSnapshot>) {
  const memories = documents.map(({ memory }) => memory);
  const rows = (sql: string) => db.prepare(sql).raw().all();
  compareRows('foreign keys', rows('PRAGMA foreign_key_check'), []);
  compareRows('memories', rows(`SELECT id, project_id, name, type, description, body_chars,
    file_path, content_hash, created_at, updated_at FROM memories`), documents.map(({ file, raw, memory: m }) => [
    m.id, PROJECT_ID, m.name, m.type, m.description, [...m.body].length,
    join(storage.memoriesDir(PROJECT_ID), file), createHash('sha256').update(raw).digest('hex'), m.created_at, m.updated_at,
  ]));
  compareRows('tags', rows('SELECT memory_id, tag FROM tags'), memories.flatMap((m) => m.tags.map((tag) => [m.id, tag])));
  compareRows('links', rows('SELECT src_id, dst_name FROM links'), memories.flatMap((m) => m.links.map((name) => [m.id, name])));
  compareRows('supersedes', rows('SELECT src_id, dst_name FROM supersedes'), memories.flatMap((m) => m.supersedes.map((name) => [m.id, name])));

  // Entity IDs are generated during reindex; compare natural keys and keep the
  // asserting memory ID so misplaced aliases/memberships/triples cannot pass.
  const names = [...new Set(memories.flatMap((m) => m.entities.map((e) => e.name)))];
  compareRows('entities', rows('SELECT project_id, name FROM entities'), names.map((name) => [PROJECT_ID, name]));
  compareRows('entity_aliases', rows(`SELECT e.project_id, e.name, a.alias, a.asserted_by
    FROM entity_aliases a LEFT JOIN entities e ON e.id = a.entity_id`),
  memories.flatMap((m) => m.entities.flatMap((e) => e.aliases.map((alias) => [PROJECT_ID, e.name, alias, m.id]))));
  compareRows('memory_entities', rows(`SELECT me.memory_id, e.project_id, e.name
    FROM memory_entities me LEFT JOIN entities e ON e.id = me.entity_id`),
  memories.flatMap((m) => m.entities.map((e) => [m.id, PROJECT_ID, e.name])));
  compareRows('entity_edges', rows(`SELECT s.project_id, s.name, edge.relation, d.project_id, d.name, edge.asserted_by
    FROM entity_edges edge LEFT JOIN entities s ON s.id = edge.src_entity_id
    LEFT JOIN entities d ON d.id = edge.dst_entity_id`),
  memories.flatMap((m) => m.triples.map(([s, relation, d]) => [PROJECT_ID, s, relation, PROJECT_ID, d, m.id])));

  compareRows('memories_fts rowids', rows('SELECT rowid FROM memories_fts'), rows('SELECT rowid FROM memories'));
  // Contentless FTS columns return NULL. Independently tokenize canonical text
  // with SQLite, then compare every stored term, document, column and position.
  db.exec(`CREATE VIRTUAL TABLE temp.expected_fts USING fts5(name, description, body, tokenize='trigram');
    CREATE VIRTUAL TABLE temp.expected_terms USING fts5vocab(temp, expected_fts, instance);
    CREATE VIRTUAL TABLE temp.actual_terms USING fts5vocab(main, memories_fts, instance)`);
  for (const m of memories) {
    db.prepare(`INSERT INTO temp.expected_fts (rowid, name, description, body)
      VALUES ((SELECT rowid FROM memories WHERE id = ?), ?, ?, ?)`).run(m.id, m.name, m.description, m.body);
  }
  compareRows('memories_fts terms', rows('SELECT term, doc, col, offset FROM temp.actual_terms'),
    rows('SELECT term, doc, col, offset FROM temp.expected_terms'));
}

export function runCleanReindex(): { memories: number; fields: readonly string[] } {
  const originalHome = process.env.LTM_HOME;
  const sourceRoot = mkdtempSync(join(tmpdir(), 'ltm-clean-reindex-source-'));
  const targetRoot = mkdtempSync(join(tmpdir(), 'ltm-clean-reindex-target-'));
  try {
    process.env.LTM_HOME = sourceRoot;
    const sourceStorage = resolveStorage();
    const sourceDb = openDb(sourceStorage.indexDb);
    const source = MemoryService.open(sourceDb, sourceStorage);
    try {
      source.save(PROJECT_ID, {
        name: 'legacy', description: 'legacy record', type: 'project', body: '旧記録', tags: ['legacy'],
        entities: [{ name: 'SQLite', aliases: ['sqlite3'] }],
      });
      source.save(PROJECT_ID, {
        name: 'current', description: 'current record', type: 'project', body: '日本語の本文と body_chars を検証する',
        tags: ['current', 'verification'], links: ['legacy'], supersedes: ['legacy'],
        entities: [{ name: 'SQLite', aliases: ['sqlite3'] }, { name: 'Turso', aliases: [] }],
        triples: [['SQLite', 'indexes', 'Turso']],
        source_refs: [{ project_id: 'source-project', memory: 'source-memory' }],
      });
      source.save(PROJECT_ID, {
        name: 'reference', description: 'reference record', type: 'reference', body: 'reference body',
        tags: ['verification'], links: ['current'], entities: [{ name: 'Turso', aliases: [] }],
      });
      const expected = markdownSnapshot(sourceStorage);

      // Only markdown is copied; no source SQLite/index artifact enters the target.
      cpSync(join(sourceRoot, 'projects'), join(targetRoot, 'projects'), { recursive: true });
      process.env.LTM_HOME = targetRoot;
      const targetStorage = resolveStorage();
      const targetDb = openDb(targetStorage.indexDb);
      const target = MemoryService.open(targetDb, targetStorage);
      try {
        if (target.listSummaries(PROJECT_ID).length !== 0) throw new Error('target index must start empty');
        target.reindex();
        // Byte-for-byte Markdown checks retain body/source_refs verification;
        // SQL expectations come from canonical files, never source index rows.
        compareRows('Markdown', markdownSnapshot(targetStorage), expected);
        verifyIndex(targetDb, targetStorage, expected);
      } finally {
        targetDb.close();
      }
    } finally {
      sourceDb.close();
    }
    return { memories: 3, fields: [...FIELDS] };
  } finally {
    if (originalHome === undefined) delete process.env.LTM_HOME;
    else process.env.LTM_HOME = originalHome;
    try {
      rmSync(sourceRoot, { recursive: true, force: true });
    } finally {
      rmSync(targetRoot, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runCleanReindex();
  console.log(`clean reindex: PASS (${result.memories} memories; ${result.fields.join(', ')} match copied Markdown)`);
}
