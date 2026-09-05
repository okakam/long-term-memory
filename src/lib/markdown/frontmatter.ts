import matter from 'gray-matter';

import { MemorySchema, type Memory } from '@/lib/memory/types';

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
  if (memory.supersedes.length > 0) data.supersedes = memory.supersedes;

  const body = memory.body.endsWith('\n') ? memory.body : `${memory.body}\n`;
  return matter.stringify(body, data);
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

  return MemorySchema.parse({
    ...data,
    tags: Array.isArray(data.tags) ? data.tags : [],
    links: Array.isArray(data.links) ? data.links : [],
    entities,
    triples,
    source_refs: sourceRefs.length > 0 ? sourceRefs : undefined,
    supersedes,
    body: parsed.content.replace(/^\n+/, '').replace(/\n+$/, ''),
    created_at: isoString(data.created_at),
    updated_at: isoString(data.updated_at),
  });
}
