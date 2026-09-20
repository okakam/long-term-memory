import { z } from 'zod';

import { isValidSlug } from '@/lib/slug';
import { MEMORY_TYPES } from '@/lib/memory/types';

const Name = z.string()
  .refine(isValidSlug, 'expected a slug: lowercase a-z / 0-9, hyphen-separated, 1..64 chars')
  .describe('Memory name as a lowercase hyphen-separated slug.');
const Description = z.string().min(1).describe('A concise one-line description; must not be empty.');
const Body = z.string().describe('The complete Markdown body of the memory.');
const Tags = z.array(z.string()).optional().describe('Optional topic tags to index with the memory.');
const Links = z.array(z.string()).optional().describe('Optional destination memory names for directional related links.');
const Supersedes = z.array(z.string()).optional().describe('Optional names of older memories replaced by this memory.');
const SourceRefs = z.array(z.object({
  project_id: z.string().min(1).describe('The source project identifier.'),
  memory: z.string().min(1).describe('The source memory name.'),
})).optional().describe('Optional provenance references to memories in other projects.');
const EntityInput = z.object({
  name: z.string().min(1).describe('Canonical concept name for a knowledge-graph node.'),
  aliases: z.array(z.string().min(1)).default([]).describe('Alternative names that resolve to this canonical concept.'),
});
const RequiredEntities = z.array(EntityInput)
  .min(1, 'Provide at least one entity (canonical concept name) extracted from the body.')
  .describe('Non-empty canonical concepts extracted from the body; required for associative recall.');
const Triples = z.array(z.tuple([
  z.string().min(1).describe('Canonical subject entity name.'),
  z.string().min(1).describe('Relationship predicate.'),
  z.string().min(1).describe('Canonical object entity name.'),
])).optional().describe('Optional [subject, predicate, object] relationships between listed entities.');
const Why = z.string().min(1).describe('The rationale for this feedback or project decision; must not be empty.');
const HowToApply = z.string().min(1).describe('The future trigger or condition for applying this feedback or decision; must not be empty.');
const IncludeShared = z.boolean().optional().describe('Whether to append matching read-only memories from the shared scope; defaults to true.');

const KnowledgeMemoryInput = {
  name: Name,
  description: Description,
  body: Body,
  tags: Tags,
  links: Links,
  entities: RequiredEntities,
  triples: Triples,
  supersedes: Supersedes,
  source_refs: SourceRefs,
};

export const RememberUserFactInput = z.object(KnowledgeMemoryInput);
export const RememberFeedbackInput = z.object({ ...KnowledgeMemoryInput, why: Why, how_to_apply: HowToApply });
export const RememberProjectFactInput = z.object({ ...KnowledgeMemoryInput, why: Why, how_to_apply: HowToApply });

const LightweightMemoryInput = {
  name: Name,
  description: Description,
  body: Body,
  tags: Tags,
  supersedes: Supersedes,
  source_refs: SourceRefs,
};

export const RememberReferenceInput = z.object({
  ...LightweightMemoryInput,
  url: z.string().url().optional().describe('Optional external URL appended to the memory body.'),
});
export const RememberSessionSummaryInput = z.object(LightweightMemoryInput);

const PatchInput = z.object({
  description: z.string().min(1).optional().describe('Replacement one-line description; omitted fields remain unchanged.'),
  body: z.string().optional().describe('Replacement complete Markdown body; omitted fields remain unchanged.'),
  tags: z.array(z.string()).optional().describe('Replacement tag list; supplied arrays overwrite the old list.'),
  links: z.array(z.string()).optional().describe('Replacement directional link list; supplied arrays overwrite the old list.'),
  entities: z.array(EntityInput).optional().describe('Replacement entity list; re-supply when changing the body.'),
  triples: z.array(z.tuple([
    z.string().min(1).describe('Canonical subject entity name.'),
    z.string().min(1).describe('Relationship predicate.'),
    z.string().min(1).describe('Canonical object entity name.'),
  ])).optional().describe('Replacement relationship list; re-supply when relations changed.'),
  supersedes: z.array(z.string()).optional().describe('Replacement names of memories this memory supersedes.'),
  source_refs: z.array(z.object({
    project_id: z.string().min(1).describe('The source project identifier.'),
    memory: z.string().min(1).describe('The source memory name.'),
  })).optional().describe('Replacement provenance references.'),
});

export const UpdateMemoryInput = z.object({
  id_or_name: z.string().min(1).describe('Existing memory ID or memory name to patch.'),
  patch: PatchInput.describe('Optional fields to replace wholesale on the existing memory.'),
});
export const ForgetMemoryInput = z.object({
  id_or_name: z.string().min(1).describe('Existing memory ID or memory name to permanently delete.'),
  reason: z.string().optional().describe('Optional reason for the permanent deletion.'),
});
export const LinkMemoriesInput = z.object({
  src: z.string().min(1).describe('Source memory name or ID; it must already exist.'),
  dst: z.string().min(1).describe('Destination memory name (slug), not an ID; it may be created later.'),
});
export const ListByTypeInput = z.object({
  type: z.enum(MEMORY_TYPES).describe('Memory type to list.'),
  limit: z.number().int().positive().max(500).optional().describe('Maximum project results to return, from 1 through 500.'),
  include_shared: IncludeShared,
});
export const SearchByTagInput = z.object({
  tags: z.array(z.string()).min(1).describe('One or more tags to match.'),
  match: z.enum(['any', 'all']).optional().describe('Use any for union matching or all for intersection matching; defaults to any.'),
  include_shared: IncludeShared,
});
export const FindRelatedInput = z.object({
  id_or_name: z.string().min(1).describe('Existing memory ID or name from which to walk directional links.'),
  depth: z.number().int().min(1).max(3).optional().describe('Link traversal depth from 1 through 3; defaults to 1.'),
  include_shared: IncludeShared,
});
export const SearchMemoriesInput = z.object({
  query: z.string().min(1).describe('Keyword query searched across memory name, description, and body.'),
  type: z.enum(MEMORY_TYPES).optional().describe('Optional memory type filter.'),
  tags: z.array(z.string()).optional().describe('Optional tag filter applied before ranking.'),
  query_entities: z.array(z.string()).optional().describe('Optional canonical concept names for graph-based associative retrieval.'),
  include_shared: IncludeShared,
});
export const GetMemoryInput = z.object({
  id_or_name: z.string().min(1).describe('Existing memory ID or name to fetch in full.'),
  include_shared: IncludeShared,
});
export const GetMemoryIndexInput = z.object({
  include_shared: IncludeShared,
});
export const ReindexInput = z.object({}).strict();

export type RememberUserFactArgs = z.infer<typeof RememberUserFactInput>;
export type RememberFeedbackArgs = z.infer<typeof RememberFeedbackInput>;
export type RememberProjectFactArgs = z.infer<typeof RememberProjectFactInput>;
export type RememberReferenceArgs = z.infer<typeof RememberReferenceInput>;
export type RememberSessionSummaryArgs = z.infer<typeof RememberSessionSummaryInput>;
export type UpdateMemoryArgs = z.infer<typeof UpdateMemoryInput>;
export type ForgetMemoryArgs = z.infer<typeof ForgetMemoryInput>;
export type LinkMemoriesArgs = z.infer<typeof LinkMemoriesInput>;
export type ListByTypeArgs = z.infer<typeof ListByTypeInput>;
export type SearchByTagArgs = z.infer<typeof SearchByTagInput>;
export type FindRelatedArgs = z.infer<typeof FindRelatedInput>;
export type SearchMemoriesArgs = z.infer<typeof SearchMemoriesInput>;
export type GetMemoryArgs = z.infer<typeof GetMemoryInput>;
export type GetMemoryIndexArgs = z.infer<typeof GetMemoryIndexInput>;
