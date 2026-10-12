import type { Memory, SaveInput } from '@/lib/memory/types';

export type CurationMode = 'schedule' | 'manual';

export interface CurationWindow {
  from: string | null;
  to: string;
  mode: CurationMode;
  dry_run: boolean;
}

export interface CurationSourceMemory {
  memory: Memory;
  content_hash: string;
}

export interface CurationMemoryCursor {
  created_at: string;
  id: string;
}

export interface CurationSourcePage {
  items: CurationSourceMemory[];
  next_after: CurationMemoryCursor | null;
}

export interface CurationOutcome {
  source_memory_id: string;
  outcome: 'promoted' | 'no_op' | 'skipped';
  reason_code: string;
  shared_memory_id?: string;
}

export interface CurationManifestItem {
  memory_id: string;
  content_hash: string;
}

export interface CurationManifestPage {
  page_index: number;
  after: string | null;
  next_after: string | null;
  snapshot_complete: boolean;
  items: CurationManifestItem[];
}

export interface CurationCursor {
  source_project_id: string;
  cursor_at: string;
  updated_at: string;
}

export interface DeferredCandidate {
  source_project_id: string;
  source_memory_id: string;
  content_hash: string;
  reason_code: string;
  created_at: string;
  updated_at: string;
}

export interface SharedRestoreRequest {
  id: string;
  memory_id: string;
  revision_id: string;
  expected_hash: string;
  requested_by: string;
  state: 'pending' | 'succeeded' | 'failed';
  requested_at: string;
  completed_at?: string;
  failure_reason?: 'memory_changed' | 'revision_missing' | 'restore_conflict' | 'restore_unavailable';
}

export interface CurationRun {
  run_id: string;
  source_project_id: string;
  window: CurationWindow;
  cursor_before: string | null;
  state: 'running' | 'complete';
  page_count: number;
  completed_page_count: number;
  snapshot_complete: boolean;
  advanced: boolean | null;
  created_at: string;
  completed_at?: string;
}

export interface CurationPage {
  view: 'sources' | 'targets';
  run_id: string;
  source_project_id: string;
  window: CurationWindow;
  page_index: number;
  memories: CurationSourceMemory[];
  next_page: string | null;
  complete: boolean;
}

export interface SharedProposal {
  operation_id: string;
  run_id: string;
  page_index: number;
  confidence: number;
  target_memory_id?: string;
  expected_target_hash?: string;
  source_refs: Array<{
    project_id: string;
    memory_id: string;
    memory: string;
    content_hash: string;
  }>;
  evidence: Array<{
    project_id: string;
    memory_id: string;
    content_hash: string;
    start: number;
    end: number;
  }>;
  memory: SaveInput;
  reason_code: string;
}

export interface CurationApplyResult {
  outcome: 'promoted' | 'deferred' | 'no_op' | 'conflict';
  change?: 'created' | 'updated' | 'existing';
  shared_memory_id?: string;
  operation_id: string;
}
