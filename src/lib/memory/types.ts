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
  supersedes: z.array(z.string().min(1)).default([]),
  body: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type Entity = z.infer<typeof EntitySchema>;
export type Triple = z.infer<typeof TripleSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type Memory = z.infer<typeof MemorySchema>;

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
