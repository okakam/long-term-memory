import { z } from 'zod';

import { EntitySchema, SourceRefSchema, TripleSchema } from '@/lib/memory/types';
import { MAINTENANCE_REASON_CODES } from '@/lib/maintenance/store';

const MemoryIdSchema = z.string().min(1).max(128);
const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const EvidenceSchema = z.object({
  memory_id: MemoryIdSchema,
  content_hash: ContentHashSchema,
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  source_index: z.number().int().nonnegative().optional(),
  source_content_hash: ContentHashSchema.optional(),
}).strict()
  .refine((item) => item.end > item.start, 'evidence range must be non-empty')
  .refine((item) => (item.source_index === undefined) === (item.source_content_hash === undefined), 'source evidence needs both source fields');

const PatchSchema = z.object({
  description: z.string().min(1).optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  links: z.array(z.string()).optional(),
  entities: z.array(EntitySchema).optional(),
  triples: z.array(TripleSchema).optional(),
  source_refs: z.array(SourceRefSchema).optional(),
  supersedes: z.array(z.string().min(1)).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, 'patch must not be empty');

export const MaintenanceProposalActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('review'), memory_id: MemoryIdSchema, review_state: z.enum(['confirmed', 'ambiguous', 'fetch_failed']) }).strict(),
  z.object({ type: z.literal('patch'), memory_id: MemoryIdSchema, patch: PatchSchema }).strict(),
  z.object({ type: z.literal('archive'), memory_id: MemoryIdSchema, archive_reason: z.enum(['expired', 'completed', 'superseded', 'session_aged']) }).strict(),
  z.object({ type: z.literal('merge'), target_id: MemoryIdSchema, source_id: MemoryIdSchema, patch: PatchSchema }).strict(),
  z.object({ type: z.literal('prune_links'), memory_id: MemoryIdSchema, names: z.array(z.string().min(1).max(256)).min(1).max(100) }).strict(),
]);

export const MaintenanceProposalSchema = z.object({
  operation_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  settings_version: z.number().int().nonnegative(),
  expected_hashes: z.record(z.string(), ContentHashSchema).refine((items) => Object.keys(items).length > 0 && Object.keys(items).length <= 2),
  action: MaintenanceProposalActionSchema,
  reason_code: z.enum(MAINTENANCE_REASON_CODES),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(EvidenceSchema).max(100),
}).strict();

export type MaintenanceEvidence = z.infer<typeof EvidenceSchema>;
export type MaintenanceProposalAction = z.infer<typeof MaintenanceProposalActionSchema>;
export type MaintenanceProposal = z.infer<typeof MaintenanceProposalSchema>;
