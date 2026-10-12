import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { MemoryConflictError } from '@/lib/memory/types';
import { atomicWriteText, computeHash } from '@/lib/markdown/file-io';
import { assertProjectId, SHARED_PROJECT_ID } from '@/lib/slug';
import { DEFAULT_MAINTENANCE_SETTINGS } from '@/lib/maintenance/policy';
import { MaintenanceSettingsSchema, type MaintenanceSettings } from '@/lib/maintenance/types';
import type {
  MaintenanceEvent,
  MaintenanceStore,
  MemoryRevision,
  MutationCommitData,
  MutationResult,
} from '@/lib/maintenance/store';
import type { Storage } from '@/lib/paths';

interface SettingsRow {
  enabled: number;
  review_days: string;
  session_archive_days: number;
  version: number;
}

interface RevisionRow {
  revision_id: string;
  memory_id: string;
  content_key: string;
  content_hash: string;
  created_at: string;
  operation_id: string;
  reason_code: string;
}

interface EventRow {
  operation_id: string;
  project_id: string;
  memory_ids: string;
  revision_ids: string;
  action: MaintenanceEvent['action'];
  reason_code: MaintenanceEvent['reason_code'];
  created_at: string;
}

interface OperationRow {
  payload_hash: string;
  outcome: MutationResult['outcome'];
  memory_ids: string;
  revision_ids: string;
}

export class LocalMaintenanceStore implements MaintenanceStore {
  constructor(private readonly db: Database.Database, private readonly storage: Storage) {}

  async getSettings(projectId: string): Promise<MaintenanceSettings> {
    const project = assertProjectId(projectId);
    const row = this.db.prepare(`SELECT enabled, review_days, session_archive_days, version
      FROM maintenance_settings WHERE project_id = ?`).get(project) as SettingsRow | undefined;
    if (!row) return {
      ...DEFAULT_MAINTENANCE_SETTINGS,
      review_days: { ...DEFAULT_MAINTENANCE_SETTINGS.review_days },
    };
    return MaintenanceSettingsSchema.parse({
      enabled: row.enabled === 1,
      review_days: JSON.parse(row.review_days),
      session_archive_days: row.session_archive_days,
      version: row.version,
    });
  }

  async saveSettings(projectId: string, settingsInput: MaintenanceSettings, expectedVersion: number): Promise<MaintenanceSettings> {
    const project = assertProjectId(projectId);
    const settings = MaintenanceSettingsSchema.parse(settingsInput);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('expectedVersion must be a non-negative integer');
    const save = this.db.transaction(() => {
      const current = this.db.prepare('SELECT version FROM maintenance_settings WHERE project_id = ?').get(project) as { version: number } | undefined;
      const version = current?.version ?? 0;
      if (version !== expectedVersion) throw new MemoryConflictError(`maintenance settings version: ${project}`);
      const next: MaintenanceSettings = { ...settings, version: version + 1 };
      this.db.prepare(`INSERT INTO maintenance_settings (project_id, enabled, review_days, session_archive_days, version)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, review_days = excluded.review_days,
          session_archive_days = excluded.session_archive_days, version = excluded.version`)
        .run(project, next.enabled ? 1 : 0, JSON.stringify(next.review_days), next.session_archive_days, next.version);
      return next;
    });
    return save();
  }

  async listEvents(projectId: string, after?: string, limit = 100): Promise<MaintenanceEvent[]> {
    const project = assertProjectId(projectId);
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const rows = (after
      ? this.db.prepare(`SELECT operation_id, project_id, memory_ids, revision_ids, action, reason_code, created_at
          FROM maintenance_events WHERE project_id = ? AND created_at > ? ORDER BY created_at, operation_id LIMIT ?`)
        .all(project, after, safeLimit)
      : this.db.prepare(`SELECT operation_id, project_id, memory_ids, revision_ids, action, reason_code, created_at
          FROM maintenance_events WHERE project_id = ? ORDER BY created_at DESC, operation_id DESC LIMIT ?`)
        .all(project, safeLimit)) as EventRow[];
    return rows.map((row) => ({
      operation_id: row.operation_id,
      project_id: row.project_id,
      memory_ids: JSON.parse(row.memory_ids) as string[],
      revision_ids: JSON.parse(row.revision_ids) as string[],
      action: row.action,
      reason_code: row.reason_code,
      created_at: row.created_at,
    }));
  }

  async listRevisions(projectId: string, memoryId: string): Promise<MemoryRevision[]> {
    const project = assertProjectId(projectId);
    const rows = this.db.prepare(`SELECT revision_id, memory_id, content_key, content_hash, created_at, operation_id, reason_code
      FROM memory_revisions WHERE project_id = ? AND memory_id = ? ORDER BY created_at DESC, revision_id DESC`)
      .all(project, memoryId) as RevisionRow[];
    return rows.map((row) => this.toRevision(row));
  }

  async readRevision(projectId: string, memoryId: string, revisionId: string): Promise<{ revision: MemoryRevision; body: string } | null> {
    const project = assertProjectId(projectId);
    const row = this.db.prepare(`SELECT revision_id, memory_id, content_key, content_hash, created_at, operation_id, reason_code
      FROM memory_revisions WHERE project_id = ? AND memory_id = ? AND revision_id = ?`)
      .get(project, memoryId, revisionId) as RevisionRow | undefined;
    if (!row || !existsSync(row.content_key)) return null;
    const body = readFileSync(row.content_key, 'utf8');
    if (computeHash(body) !== row.content_hash) return null;
    return { revision: this.toRevision(row), body };
  }

  async writeRevisionBody(projectId: string, memoryId: string, revisionId: string, body: string): Promise<string> {
    const project = assertProjectId(projectId);
    const memoryKey = createHash('sha256').update(memoryId).digest('hex');
    const key = join(this.storage.home, 'maintenance-revisions', project, memoryKey, `${revisionId}.md`);
    mkdirSync(dirname(key), { recursive: true });
    atomicWriteText(key, body);
    return key;
  }

  async deleteRevisions(projectId: string, memoryId: string): Promise<MemoryRevision[]> {
    const project = assertProjectId(projectId);
    const revisions = await this.listRevisions(project, memoryId);
    for (const revision of revisions) {
      if (existsSync(revision.content_key)) unlinkSync(revision.content_key);
    }
    this.db.prepare('DELETE FROM memory_revisions WHERE project_id = ? AND memory_id = ?').run(project, memoryId);
    return revisions;
  }

  async checkOperation(projectId: string, operationId: string, payloadHash: string): Promise<MutationResult | null> {
    const project = assertProjectId(projectId);
    const row = this.db.prepare(`SELECT payload_hash, outcome, memory_ids, revision_ids
      FROM maintenance_operations WHERE project_id = ? AND operation_id = ?`).get(project, operationId) as OperationRow | undefined;
    if (!row) return null;
    const samePayload = row.payload_hash === payloadHash;
    return {
      operation_id: operationId,
      outcome: samePayload ? 'already_applied' : 'conflict',
      memory_ids: JSON.parse(row.memory_ids) as string[],
      revision_ids: JSON.parse(row.revision_ids) as string[],
    };
  }

  async commitMutation(data: MutationCommitData, updateLocalIndex?: (data: MutationCommitData) => void): Promise<MutationResult> {
    const project = assertProjectId(data.request.project_id);
    const commit = this.db.transaction((): MutationResult => {
      const operation = this.db.prepare(`SELECT payload_hash, outcome, memory_ids, revision_ids
        FROM maintenance_operations WHERE project_id = ? AND operation_id = ?`)
        .get(project, data.request.operation_id) as OperationRow | undefined;
      if (operation) {
        return {
          operation_id: data.request.operation_id,
          outcome: operation.payload_hash === data.payload_hash ? 'already_applied' : 'conflict',
          memory_ids: JSON.parse(operation.memory_ids) as string[],
          revision_ids: JSON.parse(operation.revision_ids) as string[],
        };
      }

      if (data.request.expected_settings_version !== undefined) {
        const settings = this.db.prepare('SELECT enabled, version FROM maintenance_settings WHERE project_id = ?').get(project) as { enabled: number; version: number } | undefined;
        if (settings?.enabled !== 1 || settings.version !== data.request.expected_settings_version) return this.conflict(data.request.operation_id);
      } else if (project !== SHARED_PROJECT_ID && data.request.action.type !== 'restore') {
        return this.conflict(data.request.operation_id);
      }

      for (const [memoryId, expectedHash] of Object.entries(data.before_hashes)) {
        const current = this.db.prepare('SELECT content_hash FROM memories WHERE project_id = ? AND id = ?').get(project, memoryId) as { content_hash: string } | undefined;
        if (!current || current.content_hash !== expectedHash) return this.conflict(data.request.operation_id);
      }
      for (const snapshot of data.after) {
        const name = this.db.prepare('SELECT id FROM memories WHERE project_id = ? AND name = ?').get(project, snapshot.memory.name) as { id: string } | undefined;
        if (name && name.id !== snapshot.memory.id) return this.conflict(data.request.operation_id);
      }

      updateLocalIndex?.(data);
      const insertRevision = this.db.prepare(`INSERT INTO memory_revisions
        (project_id, memory_id, revision_id, content_key, content_hash, created_at, operation_id, reason_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const revision of data.revisions) {
        insertRevision.run(project, revision.memory_id, revision.id, revision.content_key, revision.content_hash,
          revision.created_at, revision.operation_id, revision.reason_code);
      }
      this.db.prepare(`INSERT INTO maintenance_events
        (project_id, operation_id, memory_ids, revision_ids, action, reason_code, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(project, data.event.operation_id, JSON.stringify(data.event.memory_ids), JSON.stringify(data.event.revision_ids),
          data.event.action, data.event.reason_code, data.event.created_at);
      this.db.prepare(`INSERT INTO maintenance_operations
        (project_id, operation_id, payload_hash, outcome, memory_ids, revision_ids, created_at)
        VALUES (?, ?, ?, 'applied', ?, ?, ?)`)
        .run(project, data.request.operation_id, data.payload_hash, JSON.stringify(data.result.memory_ids),
          JSON.stringify(data.result.revision_ids), data.request.now);
      return data.result;
    });
    return commit();
  }

  private toRevision(row: RevisionRow): MemoryRevision {
    return {
      id: row.revision_id,
      memory_id: row.memory_id,
      content_key: row.content_key,
      content_hash: row.content_hash,
      created_at: row.created_at,
      operation_id: row.operation_id,
      reason_code: row.reason_code as MemoryRevision['reason_code'],
    };
  }

  private conflict(operationId: string): MutationResult {
    return { operation_id: operationId, outcome: 'conflict', memory_ids: [], revision_ids: [] };
  }
}
