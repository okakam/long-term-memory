import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { openDb } from '@/lib/db/connection';
import { MemoryService } from '@/lib/memory/service';
import { resolveStorage } from '@/lib/paths';

const PROJECT_ID = 'acceptance';
const FIELDS = ['description', 'tags', 'links', 'entities', 'triples', 'source_refs', 'body_chars', 'supersedes', 'created_at', 'updated_at'] as const;

function snapshot(service: MemoryService) {
  const summaries = new Map(service.listSummaries(PROJECT_ID).map((item) => [item.name, item]));
  return [...summaries.keys()].sort().map((name) => {
    const memory = service.get(PROJECT_ID, name);
    return {
      id: memory.id,
      name: memory.name,
      type: memory.type,
      description: memory.description,
      body: memory.body,
      tags: [...memory.tags].sort(),
      links: [...memory.links].sort(),
      entities: memory.entities
        .map((entity) => ({ name: entity.name, aliases: [...entity.aliases].sort() }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      triples: memory.triples.map((triple) => [...triple]).sort(),
      source_refs: (memory.source_refs ?? [])
        .map((reference) => ({ project_id: reference.project_id, memory: reference.memory }))
        .sort((left, right) => `${left.project_id}/${left.memory}`.localeCompare(`${right.project_id}/${right.memory}`)),
      supersedes: [...memory.supersedes].sort(),
      body_chars: summaries.get(name)?.body_chars,
      created_at: memory.created_at,
      updated_at: memory.updated_at,
    };
  });
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
      const expected = snapshot(source);

      // Only markdown is copied; no source SQLite/index artifact enters the target.
      cpSync(join(sourceRoot, 'projects'), join(targetRoot, 'projects'), { recursive: true });
      process.env.LTM_HOME = targetRoot;
      const targetStorage = resolveStorage();
      const targetDb = openDb(targetStorage.indexDb);
      const target = MemoryService.open(targetDb, targetStorage);
      try {
        if (target.listSummaries(PROJECT_ID).length !== 0) throw new Error('target index must start empty');
        target.reindex();
        const actual = snapshot(target);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('clean reindex mismatch');
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
