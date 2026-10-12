import { createHash } from 'node:crypto';

import { computeHash } from '@/lib/markdown/file-io';
import type { MarkdownStore } from '@/lib/storage/contracts';
import { FirestoreMetadataStore, type MemoryIndexRecord } from '@/lib/storage/firestore-metadata';
import type { MaintenanceSettings } from '@/lib/maintenance/types';
import type {
  MaintenanceEvent,
  LinkObservation,
  MaintenanceStore,
  MemoryRevision,
  MutationCommitData,
  MutationResult,
} from '@/lib/maintenance/store';
import { assertProjectId } from '@/lib/slug';
import { bodyChars } from '@/lib/memory/types';

export class FirestoreMaintenanceStore implements MaintenanceStore {
  constructor(
    private readonly metadata: FirestoreMetadataStore,
    private readonly markdown: MarkdownStore,
    private readonly gcsPrefix: string,
  ) {}

  getSettings(projectId: string): Promise<MaintenanceSettings> {
    return this.metadata.getMaintenanceSettings(assertProjectId(projectId));
  }

  saveSettings(projectId: string, settings: MaintenanceSettings, expectedVersion: number): Promise<MaintenanceSettings> {
    return this.metadata.saveMaintenanceSettings(assertProjectId(projectId), settings, expectedVersion);
  }

  listEvents(projectId: string, after?: string, limit?: number): Promise<MaintenanceEvent[]> {
    return this.metadata.listMaintenanceEvents(assertProjectId(projectId), after, limit);
  }

  listRevisions(projectId: string, memoryId: string): Promise<MemoryRevision[]> {
    return this.metadata.listMemoryRevisions(assertProjectId(projectId), memoryId);
  }

  getLinkObservation(projectId: string, memoryId: string, dstName: string): Promise<LinkObservation | null> {
    return this.metadata.getMaintenanceLinkObservation(assertProjectId(projectId), memoryId, dstName);
  }

  observeLinkIfAbsent(projectId: string, memoryId: string, dstName: string, firstSeenAt: string): Promise<LinkObservation> {
    return this.metadata.observeMaintenanceLinkIfAbsent(assertProjectId(projectId), memoryId, dstName, firstSeenAt);
  }

  clearLinkObservation(projectId: string, memoryId: string, dstName: string): Promise<void> {
    return this.metadata.clearMaintenanceLinkObservation(assertProjectId(projectId), memoryId, dstName);
  }

  async readRevision(projectId: string, memoryId: string, revisionId: string): Promise<{ revision: MemoryRevision; body: string } | null> {
    const revision = await this.metadata.getMemoryRevision(assertProjectId(projectId), memoryId, revisionId);
    if (!revision) return null;
    try {
      const body = await this.markdown.read(revision.content_key);
      return computeHash(body) === revision.content_hash ? { revision, body } : null;
    } catch {
      return null;
    }
  }

  async writeRevisionBody(projectId: string, memoryId: string, revisionId: string, body: string): Promise<string> {
    const project = assertProjectId(projectId);
    const memoryHash = createHash('sha256').update(memoryId).digest('hex');
    const contentHash = computeHash(body);
    const key = `${this.gcsPrefix}/${project}/maintenance/revisions/${memoryHash}/${revisionId}-${contentHash}.md`;
    await this.markdown.write(key, body, { contentHash });
    return key;
  }

  async deleteRevisions(projectId: string, memoryId: string): Promise<MemoryRevision[]> {
    const revisions = await this.metadata.deleteMemoryRevisions(assertProjectId(projectId), memoryId);
    await Promise.all(revisions.map(async (revision) => {
      try { await this.markdown.remove(revision.content_key); } catch { /* tombstones prevent these objects from being restored */ }
    }));
    return revisions;
  }

  async checkOperation(projectId: string, operationId: string, payloadHash: string): Promise<MutationResult | null> {
    return this.metadata.getMaintenanceOperation(assertProjectId(projectId), operationId, payloadHash);
  }

  commitMutation(data: MutationCommitData): Promise<MutationResult> {
    const records: MemoryIndexRecord[] = data.after.map((snapshot) => ({
      id: snapshot.memory.id,
      project_id: data.request.project_id,
      name: snapshot.memory.name,
      type: snapshot.memory.type,
      description: snapshot.memory.description,
      body_chars: bodyChars(snapshot.memory.body),
      content_key: snapshot.content_key,
      content_hash: snapshot.content_hash,
      tags: snapshot.memory.tags,
      links: snapshot.memory.links,
      supersedes: snapshot.memory.supersedes,
      entities: snapshot.memory.entities,
      triples: snapshot.memory.triples,
      status: snapshot.memory.status ?? 'active',
      last_reviewed_at: snapshot.memory.last_reviewed_at,
      next_review_at: snapshot.memory.next_review_at,
      archived_at: snapshot.memory.archived_at,
      archive_reason: snapshot.memory.archive_reason,
      archived_by: snapshot.memory.archived_by,
      created_at: snapshot.memory.created_at,
      updated_at: snapshot.memory.updated_at,
    }));
    return this.metadata.commitMemoryMutation(data, records);
  }
}
