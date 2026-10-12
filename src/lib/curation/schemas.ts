import { z } from 'zod';

import { MemorySchema } from '@/lib/memory/types';

const SourceMemorySchema = z.object({
  memory: MemorySchema,
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const CurationPageSchema = z.object({
  view: z.enum(['sources', 'targets']),
  run_id: z.string().min(1).max(128),
  source_project_id: z.string().min(1).max(128),
  window: z.object({
    from: z.string().datetime({ offset: true }).nullable(),
    to: z.string().datetime({ offset: true }),
    mode: z.enum(['schedule', 'manual']),
    dry_run: z.boolean(),
  }).strict(),
  page_index: z.number().int().min(0).max(100_000),
  memories: z.array(SourceMemorySchema).max(25),
  next_page: z.string().max(4096).nullable(),
  complete: z.boolean(),
}).strict();
