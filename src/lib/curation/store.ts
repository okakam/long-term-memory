import type { CurationManifestPage, CurationOutcome, CurationRun, CurationWindow, DeferredCandidate, SharedRestoreRequest } from './types';

export interface CurationStore {
  begin(sourceProjectId: string, window: CurationWindow, now: string): Promise<CurationRun>;
  getRun(runId: string): Promise<CurationRun | null>;
  getCursor(sourceProjectId: string): Promise<string | null>;
  listDeferred(sourceProjectId: string, after?: string, limit?: number): Promise<DeferredCandidate[]>;
  saveDeferred(candidate: DeferredCandidate): Promise<void>;
  deleteDeferred(sourceProjectId: string, sourceMemoryId: string): Promise<void>;
  createRestoreRequest(request: Omit<SharedRestoreRequest, 'id' | 'state'>): Promise<SharedRestoreRequest>;
  getRestoreRequest(requestId: string): Promise<SharedRestoreRequest | null>;
  listRestoreRequests(limit?: number): Promise<SharedRestoreRequest[]>;
  completeRestoreRequest(requestId: string, result: Pick<SharedRestoreRequest, 'state' | 'completed_at' | 'failure_reason'>): Promise<SharedRestoreRequest>;
  getPage(runId: string, pageIndex: number): Promise<CurationManifestPage | null>;
  savePage(runId: string, page: CurationManifestPage): Promise<void>;
  recordOutcomes(runId: string, pageIndex: number, outcomes: CurationOutcome[]): Promise<void>;
  complete(runId: string, now?: string): Promise<{ cursor: string | null; advanced: boolean }>;
}
