import { z } from 'zod';

import { MEMORY_TYPES, EntitySchema, TripleSchema } from '@/lib/memory/types';
import { isValidSlug } from '@/lib/slug';
import { ProjectId } from './schemas';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const SourceReference = z.object({
  project_id: ProjectId,
  memory_id: z.string().min(1).max(128),
  memory: z.string().min(1).max(128),
  content_hash: Hash,
}).strict();

const SharedMemoryInput = z.object({
  name: z.string().refine(isValidSlug),
  description: z.string().min(1).max(500),
  type: z.enum(MEMORY_TYPES),
  body: z.string().max(100_000),
  tags: z.array(z.string().max(100)).max(100).optional(),
  links: z.array(z.string().refine(isValidSlug)).max(100).optional(),
  entities: z.array(EntitySchema).max(100).optional(),
  triples: z.array(TripleSchema).max(200).optional(),
  supersedes: z.array(z.string().refine(isValidSlug)).max(100).optional(),
}).strict();

export const SharedProposalSchema = z.object({
  operation_id: z.string().min(1).max(128),
  run_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  page_index: z.number().int().min(0).max(100_000),
  confidence: z.number().min(0.9).max(1),
  target_memory_id: z.string().min(1).max(128).optional(),
  expected_target_hash: Hash.optional(),
  source_refs: z.array(SourceReference).min(1).max(25),
  evidence: z.array(z.object({
    project_id: ProjectId,
    memory_id: z.string().min(1).max(128),
    content_hash: Hash,
    start: z.number().int().min(0),
    end: z.number().int().min(1),
  }).strict()).min(1).max(100),
  memory: SharedMemoryInput,
  reason_code: z.enum(['generalizable', 'exact_duplicate', 'semantic_merge']),
}).strict().superRefine((proposal, context) => {
  if ((proposal.target_memory_id === undefined) !== (proposal.expected_target_hash === undefined)) {
    context.addIssue({ code: 'custom', message: 'target ID and expected hash must be supplied together' });
  }
  if (proposal.source_refs.some((ref, index) => proposal.source_refs.findIndex((candidate) =>
    candidate.project_id === ref.project_id && candidate.memory_id === ref.memory_id) !== index)) {
    context.addIssue({ code: 'custom', message: 'source references must be unique' });
  }
});

export const CurationSnapshotInput = z.object({
  project_id: ProjectId,
  view: z.enum(['sources', 'targets']),
  mode: z.enum(['schedule', 'manual']).optional(),
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dry_run: z.boolean().default(true),
  after: z.string().max(4096).optional(),
}).strict().superRefine((input, context) => {
  if (input.view === 'targets') {
    if (input.project_id !== '__shared__' || input.mode !== undefined || input.from_date !== undefined || input.to_date !== undefined) {
      context.addIssue({ code: 'custom', message: 'target snapshot only accepts __shared__ and a page cursor' });
    }
    return;
  }
  if (input.project_id === '__shared__') context.addIssue({ code: 'custom', message: '__shared__ cannot be a source project' });
  if ((input.from_date === undefined) !== (input.to_date === undefined)) {
    context.addIssue({ code: 'custom', message: 'date range inputs must be provided together' });
  }
  if (input.after && (input.mode !== undefined || input.from_date !== undefined || input.to_date !== undefined)) {
    context.addIssue({ code: 'custom', message: 'continuation pages cannot change the run window' });
  }
});

const CurationPageCheckpointInput = z.object({
  project_id: z.literal('__shared__'),
  action: z.enum(['outcomes', 'complete']),
  source_project_id: ProjectId,
  run_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  page_index: z.number().int().min(0).max(100_000).optional(),
  outcomes: z.array(z.object({
    source_memory_id: z.string().min(1).max(128),
    outcome: z.enum(['promoted', 'no_op', 'skipped']),
    reason_code: z.string().regex(/^[a-z0-9_]{1,48}$/),
    shared_memory_id: z.string().min(1).max(128).optional(),
  }).strict()).max(25).optional(),
}).strict().superRefine((input, context) => {
  if (input.source_project_id === '__shared__') context.addIssue({ code: 'custom', message: 'source project must be ordinary' });
  if (input.action === 'outcomes' && (input.page_index === undefined || input.outcomes === undefined)) {
    context.addIssue({ code: 'custom', message: 'outcome checkpoint requires a page and outcomes' });
  }
  if (input.action === 'complete' && (input.page_index !== undefined || input.outcomes !== undefined)) {
    context.addIssue({ code: 'custom', message: 'run completion cannot include page outcomes' });
  }
});

export const CurationCheckpointInput = z.discriminatedUnion('action', [
  CurationPageCheckpointInput,
  z.object({ project_id: z.literal('__shared__'), action: z.literal('restore_requests'), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  z.object({
    project_id: z.literal('__shared__'), action: z.literal('restore_result'), request_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    state: z.enum(['succeeded', 'failed']),
    failure_reason: z.enum(['memory_changed', 'revision_missing', 'restore_conflict', 'restore_unavailable']).optional(),
  }).strict().superRefine((input, context) => {
    if ((input.state === 'failed') !== (input.failure_reason !== undefined)) {
      context.addIssue({ code: 'custom', message: 'failed restore result requires a failure reason' });
    }
  }),
]);

export const CurationApplyInput = z.union([
  z.object({
    project_id: z.literal('__shared__'),
    proposal: SharedProposalSchema,
  }).strict(),
  z.object({
    project_id: z.literal('__shared__'),
    restore_request_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  }).strict(),
]);
