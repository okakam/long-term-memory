import Database from 'better-sqlite3';
import { ulid } from 'ulid';

import { assertProjectId, SHARED_PROJECT_ID } from '@/lib/slug';
import type { CurationManifestPage, CurationOutcome, CurationRun, CurationWindow, DeferredCandidate, SharedRestoreRequest } from './types';
import type { CurationStore } from './store';

interface RunRow {
  run_id: string;
  source_project_id: string;
  window_json: string;
  cursor_before: string | null;
  state: 'running' | 'complete';
  page_count: number;
  completed_page_count: number;
  snapshot_complete: number;
  advanced: number | null;
  created_at: string;
  completed_at: string | null;
}

function toRun(row: RunRow): CurationRun {
  return {
    run_id: row.run_id,
    source_project_id: row.source_project_id,
    window: JSON.parse(row.window_json) as CurationWindow,
    cursor_before: row.cursor_before,
    state: row.state,
    page_count: row.page_count,
    completed_page_count: row.completed_page_count,
    snapshot_complete: row.snapshot_complete === 1,
    advanced: row.advanced === null ? null : row.advanced === 1,
    created_at: row.created_at,
    completed_at: row.completed_at ?? undefined,
  };
}

export class LocalCurationStore implements CurationStore {
  private readonly db: Database.Database;
  private readonly ownsDatabase: boolean;

  constructor(database: Database.Database | string = ':memory:') {
    this.ownsDatabase = typeof database === 'string';
    this.db = typeof database === 'string' ? new Database(database) : database;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shared_curation_cursors (
        source_project_id TEXT PRIMARY KEY,
        cursor_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shared_curation_runs (
        run_id TEXT PRIMARY KEY,
        source_project_id TEXT NOT NULL,
        window_json TEXT NOT NULL,
        cursor_before TEXT,
        state TEXT NOT NULL,
        page_count INTEGER NOT NULL DEFAULT 0,
        completed_page_count INTEGER NOT NULL DEFAULT 0,
        snapshot_complete INTEGER NOT NULL DEFAULT 0,
        advanced INTEGER,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS shared_curation_pages (
        run_id TEXT NOT NULL,
        page_index INTEGER NOT NULL,
        after_cursor TEXT,
        next_after_cursor TEXT,
        snapshot_complete INTEGER NOT NULL,
        items_json TEXT NOT NULL,
        outcomes_json TEXT,
        complete INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, page_index)
      );
      CREATE TABLE IF NOT EXISTS shared_curation_deferred (
        source_project_id TEXT NOT NULL,
        source_memory_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_project_id, source_memory_id)
      );
      CREATE TABLE IF NOT EXISTS shared_restore_requests (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        expected_hash TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        state TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        completed_at TEXT,
        failure_reason TEXT
      );
    `);
  }

  async begin(sourceProjectId: string, window: CurationWindow, now: string): Promise<CurationRun> {
    const project = assertProjectId(sourceProjectId);
    if (project === SHARED_PROJECT_ID || window.dry_run) throw new Error('invalid persistent curation run');
    const create = this.db.transaction((): CurationRun => {
      const current = this.db.prepare('SELECT cursor_at FROM shared_curation_cursors WHERE source_project_id = ?')
        .get(project) as { cursor_at: string } | undefined;
      const effectiveWindow = window.from === null && current ? { ...window, from: current.cursor_at } : window;
      if (effectiveWindow.from !== null && effectiveWindow.from >= effectiveWindow.to) {
        throw new Error('curation window must be non-empty');
      }
      const run: CurationRun = {
        run_id: ulid(), source_project_id: project, window: effectiveWindow,
        cursor_before: current?.cursor_at ?? null, state: 'running', page_count: 0,
        completed_page_count: 0, snapshot_complete: false, advanced: null, created_at: now,
      };
      this.db.prepare(`INSERT INTO shared_curation_runs
        (run_id, source_project_id, window_json, cursor_before, state, page_count, completed_page_count,
         snapshot_complete, advanced, created_at, completed_at)
        VALUES (?, ?, ?, ?, 'running', 0, 0, 0, NULL, ?, NULL)`)
        .run(run.run_id, project, JSON.stringify(effectiveWindow), run.cursor_before, now);
      return run;
    });
    return create();
  }

  async getRun(runId: string): Promise<CurationRun | null> {
    const row = this.db.prepare('SELECT * FROM shared_curation_runs WHERE run_id = ?').get(runId) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  async getCursor(sourceProjectId: string): Promise<string | null> {
    const row = this.db.prepare('SELECT cursor_at FROM shared_curation_cursors WHERE source_project_id = ?')
      .get(assertProjectId(sourceProjectId)) as { cursor_at: string } | undefined;
    return row?.cursor_at ?? null;
  }

  async listDeferred(sourceProjectId: string, after?: string, limit = 25): Promise<DeferredCandidate[]> {
    const bounded = Math.min(100, Math.max(1, Math.floor(limit)));
    return this.db.prepare(`SELECT source_project_id, source_memory_id, content_hash, reason_code, created_at, updated_at
      FROM shared_curation_deferred WHERE source_project_id = ? AND (? IS NULL OR source_memory_id > ?)
      ORDER BY source_memory_id ASC LIMIT ?`)
      .all(assertProjectId(sourceProjectId), after ?? null, after ?? null, bounded) as DeferredCandidate[];
  }

  async saveDeferred(candidate: DeferredCandidate): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(candidate.content_hash)) throw new Error('invalid deferred source hash');
    this.db.prepare(`INSERT INTO shared_curation_deferred
      (source_project_id, source_memory_id, content_hash, reason_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_project_id, source_memory_id) DO UPDATE SET
        content_hash = excluded.content_hash, reason_code = excluded.reason_code, updated_at = excluded.updated_at`)
      .run(assertProjectId(candidate.source_project_id), candidate.source_memory_id, candidate.content_hash,
        candidate.reason_code, candidate.created_at, candidate.updated_at);
  }

  async deleteDeferred(sourceProjectId: string, sourceMemoryId: string): Promise<void> {
    this.db.prepare('DELETE FROM shared_curation_deferred WHERE source_project_id = ? AND source_memory_id = ?')
      .run(assertProjectId(sourceProjectId), sourceMemoryId);
  }

  async createRestoreRequest(request: Omit<SharedRestoreRequest, 'id' | 'state'>): Promise<SharedRestoreRequest> {
    if (!/^[a-f0-9]{64}$/.test(request.expected_hash) || !request.memory_id || !request.revision_id || !request.requested_by) {
      throw new Error('invalid shared restore request');
    }
    const created: SharedRestoreRequest = { ...request, id: ulid(), state: 'pending' };
    this.db.prepare(`INSERT INTO shared_restore_requests
      (id, memory_id, revision_id, expected_hash, requested_by, state, requested_at, completed_at, failure_reason)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`)
      .run(created.id, created.memory_id, created.revision_id, created.expected_hash, created.requested_by, created.requested_at);
    return created;
  }

  async getRestoreRequest(requestId: string): Promise<SharedRestoreRequest | null> {
    const row = this.db.prepare('SELECT * FROM shared_restore_requests WHERE id = ?').get(requestId) as {
      id: string; memory_id: string; revision_id: string; expected_hash: string; requested_by: string; state: SharedRestoreRequest['state'];
      requested_at: string; completed_at: string | null; failure_reason: SharedRestoreRequest['failure_reason'] | null;
    } | undefined;
    return row ? {
      id: row.id, memory_id: row.memory_id, revision_id: row.revision_id, expected_hash: row.expected_hash,
      requested_by: row.requested_by, state: row.state, requested_at: row.requested_at,
      ...(row.completed_at ? { completed_at: row.completed_at } : {}),
      ...(row.failure_reason ? { failure_reason: row.failure_reason } : {}),
    } : null;
  }

  async listRestoreRequests(limit = 50): Promise<SharedRestoreRequest[]> {
    const bounded = Math.min(100, Math.max(1, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT * FROM shared_restore_requests
      ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END, requested_at DESC, id DESC LIMIT ?`)
      .all(bounded) as Array<{
        id: string; memory_id: string; revision_id: string; expected_hash: string; requested_by: string; state: SharedRestoreRequest['state'];
        requested_at: string; completed_at: string | null; failure_reason: SharedRestoreRequest['failure_reason'] | null;
      }>;
    return rows.map((row) => ({
      id: row.id, memory_id: row.memory_id, revision_id: row.revision_id, expected_hash: row.expected_hash,
      requested_by: row.requested_by, state: row.state, requested_at: row.requested_at,
      ...(row.completed_at ? { completed_at: row.completed_at } : {}),
      ...(row.failure_reason ? { failure_reason: row.failure_reason } : {}),
    }));
  }

  async completeRestoreRequest(
    requestId: string,
    result: Pick<SharedRestoreRequest, 'state' | 'completed_at' | 'failure_reason'>,
  ): Promise<SharedRestoreRequest> {
    const complete = this.db.transaction(() => {
      const current = this.getRestoreRequestSync(requestId);
      if (!current) throw new Error('shared restore request not found');
      if (current.state === 'pending') {
        this.db.prepare(`UPDATE shared_restore_requests SET state = ?, completed_at = ?, failure_reason = ?
          WHERE id = ? AND state = 'pending'`)
          .run(result.state, result.completed_at ?? null, result.failure_reason ?? null, requestId);
      }
      return this.getRestoreRequestSync(requestId)!;
    });
    return complete();
  }

  async getPage(runId: string, pageIndex: number): Promise<CurationManifestPage | null> {
    const row = this.db.prepare(`SELECT page_index, after_cursor, next_after_cursor, snapshot_complete, items_json
      FROM shared_curation_pages WHERE run_id = ? AND page_index = ?`).get(runId, pageIndex) as {
        page_index: number; after_cursor: string | null; next_after_cursor: string | null;
        snapshot_complete: number; items_json: string;
      } | undefined;
    return row ? {
      page_index: row.page_index, after: row.after_cursor, next_after: row.next_after_cursor,
      snapshot_complete: row.snapshot_complete === 1,
      items: JSON.parse(row.items_json) as CurationManifestPage['items'],
    } : null;
  }

  async savePage(runId: string, page: CurationManifestPage): Promise<void> {
    const save = this.db.transaction(() => {
      const run = this.db.prepare('SELECT * FROM shared_curation_runs WHERE run_id = ?').get(runId) as RunRow | undefined;
      if (!run || run.state !== 'running' || run.snapshot_complete === 1) throw new Error('curation run is not open');
      const existing = this.db.prepare('SELECT * FROM shared_curation_pages WHERE run_id = ? AND page_index = ?')
        .get(runId, page.page_index) as { after_cursor: string | null; next_after_cursor: string | null; snapshot_complete: number; items_json: string } | undefined;
      const pageJson = JSON.stringify(page.items);
      if (existing) {
        if (existing.after_cursor !== page.after || existing.next_after_cursor !== page.next_after
          || existing.snapshot_complete !== Number(page.snapshot_complete) || existing.items_json !== pageJson) {
          throw new Error('curation manifest page changed');
        }
        return;
      }
      if (page.page_index !== run.page_count) throw new Error('curation manifest page is out of order');
      if (page.page_index > 0) {
        const previous = this.db.prepare('SELECT next_after_cursor, snapshot_complete FROM shared_curation_pages WHERE run_id = ? AND page_index = ?')
          .get(runId, page.page_index - 1) as { next_after_cursor: string | null; snapshot_complete: number } | undefined;
        if (!previous || previous.snapshot_complete === 1 || previous.next_after_cursor !== page.after) {
          throw new Error('curation manifest page cursor mismatch');
        }
      } else if (page.after !== null) throw new Error('first curation page must not have a cursor');
      if (page.items.length > 25 || page.items.some((item) => !/^[a-f0-9]{64}$/.test(item.content_hash))) {
        throw new Error('curation manifest page exceeds limits');
      }
      this.db.prepare(`INSERT INTO shared_curation_pages
        (run_id, page_index, after_cursor, next_after_cursor, snapshot_complete, items_json, outcomes_json, complete)
        VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`)
        .run(runId, page.page_index, page.after, page.next_after, page.snapshot_complete ? 1 : 0, pageJson);
      this.db.prepare(`UPDATE shared_curation_runs SET page_count = ?, snapshot_complete = ? WHERE run_id = ?`)
        .run(page.page_index + 1, page.snapshot_complete ? 1 : 0, runId);
    });
    save();
  }

  async recordOutcomes(runId: string, pageIndex: number, outcomes: CurationOutcome[]): Promise<void> {
    const record = this.db.transaction(() => {
      const run = this.db.prepare('SELECT state FROM shared_curation_runs WHERE run_id = ?').get(runId) as { state: string } | undefined;
      if (!run || run.state !== 'running') throw new Error('curation run is not open');
      const page = this.db.prepare('SELECT * FROM shared_curation_pages WHERE run_id = ? AND page_index = ?')
        .get(runId, pageIndex) as { items_json: string; outcomes_json: string | null; complete: number } | undefined;
      if (!page) throw new Error('curation manifest page is missing');
      const items = JSON.parse(page.items_json) as CurationManifestPage['items'];
      const sortedExpected = items.map((item) => item.memory_id).sort();
      const sortedActual = outcomes.map((item) => item.source_memory_id).sort();
      if (JSON.stringify(sortedExpected) !== JSON.stringify(sortedActual)
        || new Set(sortedActual).size !== sortedActual.length) throw new Error('curation outcomes do not match manifest');
      const serialized = JSON.stringify(outcomes);
      if (page.complete === 1) {
        if (page.outcomes_json !== serialized) throw new Error('curation outcomes changed');
        return;
      }
      this.db.prepare('UPDATE shared_curation_pages SET outcomes_json = ?, complete = 1 WHERE run_id = ? AND page_index = ?')
        .run(serialized, runId, pageIndex);
      this.db.prepare('UPDATE shared_curation_runs SET completed_page_count = completed_page_count + 1 WHERE run_id = ?')
        .run(runId);
    });
    record();
  }

  async complete(runId: string, now = new Date().toISOString()): Promise<{ cursor: string | null; advanced: boolean }> {
    const finish = this.db.transaction(() => {
      const runRow = this.db.prepare('SELECT * FROM shared_curation_runs WHERE run_id = ?').get(runId) as RunRow | undefined;
      if (!runRow) throw new Error('curation run not found');
      const run = toRun(runRow);
      if (run.state === 'complete') return { cursor: this.getCursorSync(run.source_project_id), advanced: run.advanced ?? false };
      if (!run.snapshot_complete || run.page_count === 0 || run.completed_page_count !== run.page_count) {
        return { cursor: this.getCursorSync(run.source_project_id), advanced: false };
      }
      let advanced = false;
      let cursor = this.getCursorSync(run.source_project_id);
      if (run.window.mode === 'schedule' && !run.window.dry_run && cursor === run.cursor_before) {
        this.db.prepare(`INSERT INTO shared_curation_cursors (source_project_id, cursor_at, updated_at)
          VALUES (?, ?, ?) ON CONFLICT(source_project_id) DO UPDATE SET cursor_at = excluded.cursor_at, updated_at = excluded.updated_at`)
          .run(run.source_project_id, run.window.to, now);
        cursor = run.window.to;
        advanced = true;
      }
      this.db.prepare(`UPDATE shared_curation_runs SET state = 'complete', advanced = ?, completed_at = ? WHERE run_id = ?`)
        .run(advanced ? 1 : 0, now, runId);
      return { cursor, advanced };
    });
    return finish();
  }

  close(): void {
    if (this.ownsDatabase) this.db.close();
  }

  private getCursorSync(sourceProjectId: string): string | null {
    const row = this.db.prepare('SELECT cursor_at FROM shared_curation_cursors WHERE source_project_id = ?')
      .get(sourceProjectId) as { cursor_at: string } | undefined;
    return row?.cursor_at ?? null;
  }

  private getRestoreRequestSync(requestId: string): SharedRestoreRequest | null {
    const row = this.db.prepare('SELECT * FROM shared_restore_requests WHERE id = ?').get(requestId) as {
      id: string; memory_id: string; revision_id: string; expected_hash: string; requested_by: string; state: SharedRestoreRequest['state'];
      requested_at: string; completed_at: string | null; failure_reason: SharedRestoreRequest['failure_reason'] | null;
    } | undefined;
    return row ? {
      id: row.id, memory_id: row.memory_id, revision_id: row.revision_id, expected_hash: row.expected_hash,
      requested_by: row.requested_by, state: row.state, requested_at: row.requested_at,
      ...(row.completed_at ? { completed_at: row.completed_at } : {}),
      ...(row.failure_reason ? { failure_reason: row.failure_reason } : {}),
    } : null;
  }
}
