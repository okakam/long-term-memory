import { ulid } from 'ulid';
import { createHash } from 'node:crypto';

import type { FirestoreDocument, FirestoreGateway } from '@/lib/storage/firestore-metadata';
import { assertProjectId, SHARED_PROJECT_ID } from '@/lib/slug';
import type { CurationManifestPage, CurationOutcome, CurationRun, CurationWindow, DeferredCandidate, SharedRestoreRequest } from './types';
import type { CurationStore } from './store';

function path(...parts: string[]): string {
  return parts.join('/');
}

function cursorPath(sourceProjectId: string): string {
  return path('projects', SHARED_PROJECT_ID, 'sharedCurationCursors', assertProjectId(sourceProjectId));
}

function runPath(runId: string): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(runId)) throw new Error('invalid curation run ID');
  return path('projects', SHARED_PROJECT_ID, 'curationRuns', runId);
}

function pagePath(runId: string, pageIndex: number): string {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw new Error('invalid curation page index');
  return path(runPath(runId), 'pages', String(pageIndex).padStart(8, '0'));
}

function deferredPath(sourceProjectId: string, sourceMemoryId: string): string {
  const id = createHash('sha256').update(`${assertProjectId(sourceProjectId)}\n${sourceMemoryId}`).digest('hex');
  return path('projects', SHARED_PROJECT_ID, 'deferredCandidates', id);
}

function restoreRequestPath(requestId: string): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(requestId)) throw new Error('invalid shared restore request ID');
  return path('projects', SHARED_PROJECT_ID, 'sharedRestoreRequests', requestId);
}

function restoreRequestOf(document: FirestoreDocument): SharedRestoreRequest {
  const data = dataOf(document);
  if (typeof data.id !== 'string' || typeof data.memory_id !== 'string' || typeof data.revision_id !== 'string'
    || typeof data.expected_hash !== 'string' || !/^[a-f0-9]{64}$/.test(data.expected_hash)
    || typeof data.requested_by !== 'string' || !['pending', 'succeeded', 'failed'].includes(String(data.state))
    || typeof data.requested_at !== 'string'
    || (data.completed_at !== null && typeof data.completed_at !== 'string')) {
    throw new Error('shared restore request metadata is malformed');
  }
  const reasons = ['memory_changed', 'revision_missing', 'restore_conflict', 'restore_unavailable'];
  if (data.failure_reason !== null && !reasons.includes(String(data.failure_reason))) {
    throw new Error('shared restore request failure metadata is malformed');
  }
  return {
    id: data.id, memory_id: data.memory_id, revision_id: data.revision_id, expected_hash: data.expected_hash,
    requested_by: data.requested_by, state: data.state as SharedRestoreRequest['state'], requested_at: data.requested_at,
    ...(typeof data.completed_at === 'string' ? { completed_at: data.completed_at } : {}),
    ...(typeof data.failure_reason === 'string' ? { failure_reason: data.failure_reason as NonNullable<SharedRestoreRequest['failure_reason']> } : {}),
  };
}

function dataOf(document: FirestoreDocument): Record<string, unknown> {
  const data = document.data();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('curation metadata is malformed');
  return data;
}

function runOf(document: FirestoreDocument): CurationRun {
  const data = dataOf(document);
  if (typeof data.run_id !== 'string' || typeof data.source_project_id !== 'string'
    || typeof data.window_json !== 'string' || (data.state !== 'running' && data.state !== 'complete')
    || typeof data.page_count !== 'number' || typeof data.completed_page_count !== 'number'
    || typeof data.snapshot_complete !== 'boolean' || typeof data.created_at !== 'string'
    || (data.cursor_before !== null && typeof data.cursor_before !== 'string')
    || (data.advanced !== null && typeof data.advanced !== 'boolean')) throw new Error('curation run metadata is malformed');
  return {
    run_id: data.run_id,
    source_project_id: assertProjectId(data.source_project_id),
    window: JSON.parse(data.window_json) as CurationWindow,
    cursor_before: data.cursor_before,
    state: data.state,
    page_count: data.page_count,
    completed_page_count: data.completed_page_count,
    snapshot_complete: data.snapshot_complete,
    advanced: data.advanced,
    created_at: data.created_at,
    completed_at: typeof data.completed_at === 'string' ? data.completed_at : undefined,
  };
}

function pageOf(document: FirestoreDocument): CurationManifestPage {
  const data = dataOf(document);
  if (typeof data.page_index !== 'number' || !Number.isSafeInteger(data.page_index)
    || (data.after !== null && typeof data.after !== 'string')
    || (data.next_after !== null && typeof data.next_after !== 'string')
    || typeof data.snapshot_complete !== 'boolean' || !Array.isArray(data.items)) {
    throw new Error('curation manifest page is malformed');
  }
  return {
    page_index: data.page_index,
    after: data.after,
    next_after: data.next_after,
    snapshot_complete: data.snapshot_complete,
    items: data.items as CurationManifestPage['items'],
  };
}

function validateManifestPage(page: CurationManifestPage): void {
  if (!Number.isSafeInteger(page.page_index) || page.page_index < 0 || page.items.length > 25
    || page.items.some((item) => !item.memory_id || !/^[a-f0-9]{64}$/.test(item.content_hash))
    || new Set(page.items.map((item) => item.memory_id)).size !== page.items.length) {
    throw new Error('curation manifest page exceeds limits');
  }
}

function validateOutcomes(items: CurationManifestPage['items'], outcomes: CurationOutcome[]): void {
  const expected = items.map((item) => item.memory_id).sort();
  const actual = outcomes.map((item) => item.source_memory_id).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual) || new Set(actual).size !== actual.length
    || outcomes.some((item) => !['promoted', 'no_op', 'skipped'].includes(item.outcome)
      || !/^[a-z0-9_]{1,48}$/.test(item.reason_code))) throw new Error('curation outcomes do not match manifest');
}

export class FirestoreCurationStore implements CurationStore {
  constructor(private readonly gateway: FirestoreGateway) {}

  async begin(sourceProjectId: string, window: CurationWindow, now: string): Promise<CurationRun> {
    const project = assertProjectId(sourceProjectId);
    if (project === SHARED_PROJECT_ID || window.dry_run) throw new Error('invalid persistent curation run');
    const id = ulid();
    return this.gateway.runTransaction(async (transaction) => {
      const cursorDocument = await transaction.get(cursorPath(project));
      const currentCursor = cursorDocument.exists ? dataOf(cursorDocument).cursor_at : null;
      if (currentCursor !== null && typeof currentCursor !== 'string') throw new Error('curation cursor is malformed');
      const run: CurationRun = {
        run_id: id,
        source_project_id: project,
        window: window.from === null && currentCursor ? { ...window, from: currentCursor } : window,
        cursor_before: currentCursor,
        state: 'running',
        page_count: 0,
        completed_page_count: 0,
        snapshot_complete: false,
        advanced: null,
        created_at: now,
      };
      if (run.window.from !== null && run.window.from >= run.window.to) throw new Error('curation window must be non-empty');
      await transaction.set(runPath(id), {
        run_id: run.run_id,
        source_project_id: run.source_project_id,
        window_json: JSON.stringify(run.window),
        cursor_before: run.cursor_before,
        state: run.state,
        page_count: 0,
        completed_page_count: 0,
        snapshot_complete: false,
        advanced: null,
        created_at: run.created_at,
        completed_at: null,
      });
      return run;
    });
  }

  async getRun(runId: string): Promise<CurationRun | null> {
    const document = await this.gateway.get(runPath(runId));
    return document.exists ? runOf(document) : null;
  }

  async getCursor(sourceProjectId: string): Promise<string | null> {
    const document = await this.gateway.get(cursorPath(sourceProjectId));
    if (!document.exists) return null;
    const value = dataOf(document).cursor_at;
    if (typeof value !== 'string') throw new Error('curation cursor is malformed');
    return value;
  }

  async listDeferred(sourceProjectId: string, after?: string, limit = 25): Promise<DeferredCandidate[]> {
    const project = assertProjectId(sourceProjectId);
    const records = (await this.gateway.list(path('projects', SHARED_PROJECT_ID, 'deferredCandidates')))
      .filter((document) => document.exists)
      .map((document): DeferredCandidate => {
        const data = dataOf(document);
        if (typeof data.source_project_id !== 'string' || typeof data.source_memory_id !== 'string'
          || typeof data.content_hash !== 'string' || typeof data.reason_code !== 'string'
          || typeof data.created_at !== 'string' || typeof data.updated_at !== 'string') {
          throw new Error('deferred curation candidate is malformed');
        }
        return {
          source_project_id: data.source_project_id,
          source_memory_id: data.source_memory_id,
          content_hash: data.content_hash,
          reason_code: data.reason_code,
          created_at: data.created_at,
          updated_at: data.updated_at,
        };
      })
      .filter((candidate) => candidate.source_project_id === project
        && (after === undefined || candidate.source_memory_id > after))
      .sort((left, right) => left.source_memory_id.localeCompare(right.source_memory_id));
    return records.slice(0, Math.min(100, Math.max(1, Math.floor(limit))));
  }

  async saveDeferred(candidate: DeferredCandidate): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(candidate.content_hash)) throw new Error('invalid deferred source hash');
    await this.gateway.set(deferredPath(candidate.source_project_id, candidate.source_memory_id), { ...candidate }, true);
  }

  async deleteDeferred(sourceProjectId: string, sourceMemoryId: string): Promise<void> {
    await this.gateway.delete(deferredPath(sourceProjectId, sourceMemoryId));
  }

  async createRestoreRequest(request: Omit<SharedRestoreRequest, 'id' | 'state'>): Promise<SharedRestoreRequest> {
    if (!/^[a-f0-9]{64}$/.test(request.expected_hash) || !request.memory_id || !request.revision_id || !request.requested_by) {
      throw new Error('invalid shared restore request');
    }
    const created: SharedRestoreRequest = { ...request, id: ulid(), state: 'pending' };
    await this.gateway.set(restoreRequestPath(created.id), {
      ...created,
      completed_at: null,
      failure_reason: null,
    });
    return created;
  }

  async getRestoreRequest(requestId: string): Promise<SharedRestoreRequest | null> {
    const document = await this.gateway.get(restoreRequestPath(requestId));
    return document.exists ? restoreRequestOf(document) : null;
  }

  async listRestoreRequests(limit = 50): Promise<SharedRestoreRequest[]> {
    const documents = await this.gateway.list(path('projects', SHARED_PROJECT_ID, 'sharedRestoreRequests'));
    return documents.filter((document) => document.exists).map(restoreRequestOf)
      .sort((left, right) => Number(right.state === 'pending') - Number(left.state === 'pending')
        || right.requested_at.localeCompare(left.requested_at) || right.id.localeCompare(left.id))
      .slice(0, Math.min(100, Math.max(1, Math.floor(limit))));
  }

  async completeRestoreRequest(
    requestId: string,
    result: Pick<SharedRestoreRequest, 'state' | 'completed_at' | 'failure_reason'>,
  ): Promise<SharedRestoreRequest> {
    return this.gateway.runTransaction(async (transaction) => {
      const targetPath = restoreRequestPath(requestId);
      const document = await transaction.get(targetPath);
      if (!document.exists) throw new Error('shared restore request not found');
      const current = restoreRequestOf(document);
      if (current.state !== 'pending') return current;
      await transaction.set(targetPath, {
        state: result.state,
        completed_at: result.completed_at ?? null,
        failure_reason: result.failure_reason ?? null,
      }, true);
      return { ...current, ...result };
    });
  }

  async getPage(runId: string, pageIndex: number): Promise<CurationManifestPage | null> {
    const document = await this.gateway.get(pagePath(runId, pageIndex));
    return document.exists ? pageOf(document) : null;
  }

  async savePage(runId: string, page: CurationManifestPage): Promise<void> {
    validateManifestPage(page);
    await this.gateway.runTransaction(async (transaction) => {
      const runDocument = await transaction.get(runPath(runId));
      if (!runDocument.exists) throw new Error('curation run not found');
      const run = runOf(runDocument);
      const currentPagePath = pagePath(runId, page.page_index);
      const currentPageDocument = await transaction.get(currentPagePath);
      if (currentPageDocument.exists) {
        const existing = pageOf(currentPageDocument);
        if (JSON.stringify(existing) !== JSON.stringify(page)) throw new Error('curation manifest page changed');
        return;
      }
      if (run.state !== 'running' || run.snapshot_complete || page.page_index !== run.page_count) {
        throw new Error('curation run is not open');
      }
      if (page.page_index === 0 && page.after !== null) throw new Error('first curation page must not have a cursor');
      if (page.page_index > 0) {
        const previousDocument = await transaction.get(pagePath(runId, page.page_index - 1));
        if (!previousDocument.exists) throw new Error('previous curation manifest page is missing');
        const previous = pageOf(previousDocument);
        if (previous.snapshot_complete || previous.next_after !== page.after) throw new Error('curation page cursor mismatch');
      }
      await transaction.set(currentPagePath, {
        page_index: page.page_index,
        after: page.after,
        next_after: page.next_after,
        snapshot_complete: page.snapshot_complete,
        items: page.items,
        outcomes: null,
        complete: false,
      });
      await transaction.set(runPath(runId), {
        page_count: run.page_count + 1,
        snapshot_complete: page.snapshot_complete,
      }, true);
    });
  }

  async recordOutcomes(runId: string, pageIndex: number, outcomes: CurationOutcome[]): Promise<void> {
    await this.gateway.runTransaction(async (transaction) => {
      const runDocument = await transaction.get(runPath(runId));
      const targetPath = pagePath(runId, pageIndex);
      const pageDocument = await transaction.get(targetPath);
      if (!runDocument.exists || !pageDocument.exists) throw new Error('curation manifest page is missing');
      const run = runOf(runDocument);
      if (run.state !== 'running') throw new Error('curation run is not open');
      const manifest = pageOf(pageDocument);
      validateOutcomes(manifest.items, outcomes);
      const data = dataOf(pageDocument);
      const serialized = JSON.stringify(outcomes);
      if (data.complete === true) {
        if (data.outcomes_json !== serialized) throw new Error('curation outcomes changed');
        return;
      }
      await transaction.set(targetPath, { outcomes_json: serialized, complete: true }, true);
      await transaction.set(runPath(runId), { completed_page_count: run.completed_page_count + 1 }, true);
    });
  }

  async complete(runId: string, now = new Date().toISOString()): Promise<{ cursor: string | null; advanced: boolean }> {
    return this.gateway.runTransaction(async (transaction) => {
      const runDocument = await transaction.get(runPath(runId));
      if (!runDocument.exists) throw new Error('curation run not found');
      const run = runOf(runDocument);
      const targetCursorPath = cursorPath(run.source_project_id);
      const cursorDocument = await transaction.get(targetCursorPath);
      const cursorData = cursorDocument.exists ? dataOf(cursorDocument) : null;
      const currentCursor = cursorData?.cursor_at ?? null;
      if (currentCursor !== null && typeof currentCursor !== 'string') throw new Error('curation cursor is malformed');
      if (run.state === 'complete') return { cursor: currentCursor, advanced: run.advanced ?? false };
      if (!run.snapshot_complete || run.page_count === 0 || run.completed_page_count !== run.page_count) {
        return { cursor: currentCursor, advanced: false };
      }
      const shouldAdvance = run.window.mode === 'schedule' && !run.window.dry_run && currentCursor === run.cursor_before;
      const nextCursor = shouldAdvance ? run.window.to : currentCursor;
      if (shouldAdvance) await transaction.set(targetCursorPath, {
        source_project_id: run.source_project_id,
        cursor_at: run.window.to,
        updated_at: now,
      });
      await transaction.set(runPath(runId), {
        state: 'complete',
        advanced: shouldAdvance,
        completed_at: now,
      }, true);
      return { cursor: nextCursor, advanced: shouldAdvance };
    });
  }
}
