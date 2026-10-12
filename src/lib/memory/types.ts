import { z } from 'zod';

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'session'] as const;

export const EntitySchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
});

export const TripleSchema = z.tuple([
  z.string().min(1),
  z.string().min(1),
  z.string().min(1),
]);

export const SourceRefSchema = z.object({
  project_id: z.string().min(1).describe('Source project identifier.'),
  memory: z.string().min(1).describe('Source memory name.'),
});

const SourceTimestamp = z.string().datetime({ offset: false });
const HttpsSourceUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.username === '' && url.password === '';
}, 'source URL must use HTTPS and contain no credentials');

export const MemorySourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    url: HttpsSourceUrl,
    captured_at: SourceTimestamp,
    last_checked_at: SourceTimestamp.optional(),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }),
  z.object({
    kind: z.literal('conversation'),
    captured_at: SourceTimestamp,
  }),
]);

export const MemoryStatusSchema = z.enum(['active', 'archived']);

export const MemorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  type: z.enum(MEMORY_TYPES),
  tags: z.array(z.string()).default([]),
  links: z.array(z.string()).default([]),
  entities: z.array(EntitySchema).default([]),
  triples: z.array(TripleSchema).default([]),
  source_refs: z.array(SourceRefSchema).optional(),
  sources: z.array(MemorySourceSchema).optional(),
  supersedes: z.array(z.string().min(1)).default([]),
  last_reviewed_at: SourceTimestamp.optional(),
  next_review_at: SourceTimestamp.optional(),
  status: MemoryStatusSchema.optional(),
  archived_at: SourceTimestamp.optional(),
  archive_reason: z.string().min(1).optional(),
  archived_by: z.string().min(1).optional(),
  body: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type Entity = z.infer<typeof EntitySchema>;
export type Triple = z.infer<typeof TripleSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type MemorySource = z.infer<typeof MemorySourceSchema>;
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;
export type Memory = z.infer<typeof MemorySchema>;

export interface MemorySummary {
  id: string;
  name: string;
  type: MemoryType;
  description: string;
  body_chars: number;
  updated_at: string;
  tags: string[];
  links: string[];
}

export type MemorySearchResult = Memory & { relevance: number };

export interface SaveInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  tags?: string[];
  links?: string[];
  entities?: Entity[];
  triples?: Triple[];
  source_refs?: SourceRef[];
  supersedes?: string[];
}

export type UpdateInput = Partial<Omit<SaveInput, 'name' | 'type'>>;

export function bodyChars(body: string): number {
  return [...body].length;
}

export class MemoryNotFoundError extends Error {
  constructor(idOrName: string) {
    super(`memory not found: ${idOrName}`);
    this.name = 'MemoryNotFoundError';
  }
}

export class MemoryConflictError extends Error {
  constructor(name: string) {
    super(`memory name already exists: ${name}`);
    this.name = 'MemoryConflictError';
  }
}

export class UnknownEntityError extends Error {
  constructor(name: string) {
    super(`triple references unknown entity (not in entities list): ${name}`);
    this.name = 'UnknownEntityError';
  }
}
