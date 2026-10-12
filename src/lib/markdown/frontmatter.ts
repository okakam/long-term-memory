import matter from 'gray-matter';

import { MemorySchema, MemorySourceSchema, type Memory, type MemorySource } from '@/lib/memory/types';

function isoString(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function serializeMemory(memory: Memory): string {
  const data: Record<string, unknown> = {
    id: memory.id,
    name: memory.name,
    description: memory.description,
    type: memory.type,
    tags: memory.tags,
    links: memory.links,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
  };

  if (memory.entities.length > 0) {
    data.entities = memory.entities.map((entity) => entity.aliases.length > 0
      ? { name: entity.name, aliases: entity.aliases }
      : { name: entity.name });
  }
  if (memory.triples.length > 0) data.triples = memory.triples;
  if (memory.source_refs && memory.source_refs.length > 0) data.source_refs = memory.source_refs;
  if (memory.sources && memory.sources.length > 0) data.sources = memory.sources;
  if (memory.supersedes.length > 0) data.supersedes = memory.supersedes;
  if (memory.last_reviewed_at) data.last_reviewed_at = memory.last_reviewed_at;
  if (memory.next_review_at) data.next_review_at = memory.next_review_at;
  if (memory.status) data.status = memory.status;
  if (memory.archived_at) data.archived_at = memory.archived_at;
  if (memory.archive_reason) data.archive_reason = memory.archive_reason;
  if (memory.archived_by) data.archived_by = memory.archived_by;

  const body = memory.body.endsWith('\n') ? memory.body : `${memory.body}\n`;
  return matter.stringify(body, data);
}

export function sourcesFromBody(body: string, capturedAt: string): MemorySource[] {
  const sources: MemorySource[] = [];
  for (const match of body.matchAll(/^\s*URL:\s*(\S+)\s*$/gim)) {
    const parsed = MemorySourceSchema.safeParse({ kind: 'url', url: match[1], captured_at: capturedAt });
    if (parsed.success && parsed.data.kind === 'url') {
      const url = parsed.data.url;
      if (!sources.some((source) => source.kind === 'url' && source.url === url)) sources.push(parsed.data);
    }
  }
  return sources;
}

export function parseMemoryString(text: string): Memory {
  const parsed = matter(text);
  const data = parsed.data as Record<string, unknown>;
  const entities = Array.isArray(data.entities)
    ? data.entities.map((entity) => {
        if (!isRecord(entity)) return entity;
        const aliases = Array.isArray(entity.aliases)
          ? entity.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.length > 0)
          : [];
        return { ...entity, aliases };
      })
    : [];
  const triples = Array.isArray(data.triples)
    ? data.triples.filter((triple): triple is [string, string, string] =>
        Array.isArray(triple)
        && triple.length === 3
        && triple.every((value) => typeof value === 'string'))
    : [];
  const sourceRefs = Array.isArray(data.source_refs)
    ? data.source_refs.filter((ref) =>
        isRecord(ref)
        && typeof ref.project_id === 'string'
        && typeof ref.memory === 'string')
    : [];
  const supersedes = Array.isArray(data.supersedes)
    ? data.supersedes.filter((name): name is string => typeof name === 'string' && name.length > 0)
    : [];
  const body = parsed.content.replace(/^\n+/, '').replace(/\n+$/, '');
  const createdAt = isoString(data.created_at);
  const rawSources = Array.isArray(data.sources)
    ? data.sources.flatMap((source) => {
      if (!isRecord(source)) return [];
      const normalized = {
        ...source,
        captured_at: isoString(source.captured_at),
        last_checked_at: isoString(source.last_checked_at),
      };
      const result = MemorySourceSchema.safeParse(normalized);
      return result.success ? [result.data] : [];
    })
    : [];
  const sources = rawSources.length > 0
    ? rawSources
    : typeof createdAt === 'string' ? sourcesFromBody(body, createdAt) : [];

  return MemorySchema.parse({
    ...data,
    tags: Array.isArray(data.tags) ? data.tags : [],
    links: Array.isArray(data.links) ? data.links : [],
    entities,
    triples,
    source_refs: sourceRefs.length > 0 ? sourceRefs : undefined,
    sources: sources.length > 0 ? sources : undefined,
    supersedes,
    status: data.status ?? 'active',
    body,
    created_at: createdAt,
    updated_at: isoString(data.updated_at),
  });
}
