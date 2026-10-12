import type { Memory, MemorySource, SaveInput, UpdateInput } from '@/lib/memory/types';
import type { MaintenanceSettings } from '@/lib/maintenance/types';

export const MAINTENANCE_REASON_CODES = [
  'confirmed', 'ambiguous', 'fetch_failed', 'exact_duplicate', 'semantic_duplicate',
  'expired', 'completed', 'superseded', 'session_aged', 'missing_link', 'restored', 'shared_promoted',
] as const;

export type MaintenanceReasonCode = (typeof MAINTENANCE_REASON_CODES)[number];
export type ReviewState = 'confirmed' | 'ambiguous' | 'fetch_failed';

export type MutationAction =
  | { type: 'review'; memory_id: string; review_state: ReviewState; next_review_at: string; sources?: MemorySource[] }
  | { type: 'patch'; memory_id: string; patch: UpdateInput; sources?: MemorySource[] }
  | { type: 'archive'; memory_id: string; archive_reason: string }
  | { type: 'merge'; target_id: string; source_id: string; patch: UpdateInput; sources?: MemorySource[]; archive_reason?: string }
  | { type: 'prune_links'; memory_id: string; names: string[] }
  | { type: 'restore'; memory_id: string; revision_id: string }
  | { type: 'create'; input: SaveInput };

export interface MutationRequest {
  operation_id: string;
  project_id: string;
  idempotency_hash?: string;
  expected_hashes: Record<string, string>;
  expected_settings_version?: number;
  action: MutationAction;
  reason_code: MaintenanceReasonCode;
  now: string;
}

export interface MutationResult {
  operation_id: string;
  outcome: 'applied' | 'already_applied' | 'conflict';
  memory_ids: string[];
  revision_ids: string[];
}

export interface MemoryRevision {
  id: string;
  memory_id: string;
  content_key: string;
  content_hash: string;
  created_at: string;
  operation_id: string;
  reason_code: MaintenanceReasonCode;
}

export interface MaintenanceEvent {
  operation_id: string;
  project_id: string;
  memory_ids: string[];
  revision_ids: string[];
  action: MutationAction['type'];
  reason_code: MaintenanceReasonCode;
  created_at: string;
}

export interface LinkObservation {
  memory_id: string;
  dst_name: string;
  first_seen_at: string;
}

export interface MaintenanceMemoryRecord {
  memory: Memory;
  content_hash: string;
}

export interface MaintenanceMemoryPage {
  items: MaintenanceMemoryRecord[];
  next_after: string | null;
}

export interface MaintenancePage {
  memories: Array<MaintenanceMemoryRecord & { due: boolean; missing_links: string[] }>;
  settings_version: number;
  next_page: string | null;
}

export interface MutationSnapshot {
  memory: Memory;
  content_key: string;
  content_hash: string;
}

export interface MutationCommitData {
  request: MutationRequest;
  payload_hash: string;
  before_hashes: Record<string, string>;
  after: MutationSnapshot[];
  revisions: MemoryRevision[];
  event: MaintenanceEvent;
  result: MutationResult;
}

export interface MaintenanceStore {
  getSettings(projectId: string): Promise<MaintenanceSettings>;
  saveSettings(projectId: string, settings: MaintenanceSettings, expectedVersion: number): Promise<MaintenanceSettings>;
  listEvents(projectId: string, after?: string, limit?: number): Promise<MaintenanceEvent[]>;
  listRevisions(projectId: string, memoryId: string): Promise<MemoryRevision[]>;
  getLinkObservation(projectId: string, memoryId: string, dstName: string): Promise<LinkObservation | null>;
  observeLinkIfAbsent(projectId: string, memoryId: string, dstName: string, firstSeenAt: string): Promise<LinkObservation>;
  clearLinkObservation(projectId: string, memoryId: string, dstName: string): Promise<void>;
  readRevision(projectId: string, memoryId: string, revisionId: string): Promise<{ revision: MemoryRevision; body: string } | null>;
  writeRevisionBody(projectId: string, memoryId: string, revisionId: string, body: string): Promise<string>;
  deleteRevisions(projectId: string, memoryId: string): Promise<MemoryRevision[]>;
  checkOperation(projectId: string, operationId: string, payloadHash: string): Promise<MutationResult | null>;
  commitMutation(data: MutationCommitData, updateLocalIndex?: (data: MutationCommitData) => void): Promise<MutationResult>;
}

export interface MemoryMutationPort {
  applyMutationAsync(request: MutationRequest): Promise<MutationResult>;
  listRevisionsAsync(projectId: string, memoryId: string): Promise<MemoryRevision[]>;
}

export interface MaintenanceMemorySource extends MemoryMutationPort {
  readonly maintenanceStore: MaintenanceStore;
  listMaintenanceMemories(projectId: string, after?: string, limit?: number): Promise<MaintenanceMemoryPage>;
  listArchivedMaintenanceMemories(projectId: string, after?: string, limit?: number): Promise<MaintenanceMemoryPage>;
  getMaintenanceMemory(projectId: string, memoryId: string): Promise<MaintenanceMemoryRecord | null>;
  maintenanceNameExists(projectId: string, name: string): Promise<boolean>;
}
