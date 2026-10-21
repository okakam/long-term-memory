import { FieldPath, getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';

import type { MemberRecord, ProjectRecord, TokenRecord } from '@/lib/auth/store';
import { getFirebaseAdminApp } from '@/lib/auth/firebase';
import { MemoryConflictError } from '@/lib/memory/types';
import type { Entity, MemoryStatus, MemoryType, Triple } from '@/lib/memory/types';
import { assertMemoryName, assertProjectId } from '@/lib/slug';
import { DEFAULT_MAINTENANCE_SETTINGS, MISSING_LINK_GRACE_DAYS } from '@/lib/maintenance/policy';
import { decodeMaintenanceEventCursor } from '@/lib/maintenance/cursor';
import { MaintenanceSettingsSchema, type MaintenanceSettings } from '@/lib/maintenance/types';
import type { LinkObservation, MaintenanceEvent, MemoryRevision, MutationCommitData, MutationResult } from '@/lib/maintenance/store';

export interface FirestoreDocument {
  id: string;
  path: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface FirestoreTransaction {
  get(path: string): Promise<FirestoreDocument>;
  list(collectionPath: string): Promise<FirestoreDocument[]>;
  set(path: string, data: Record<string, unknown>, merge?: boolean): void | Promise<void>;
  update(path: string, data: Record<string, unknown>): void | Promise<void>;
  delete(path: string): void | Promise<void>;
}

export interface FirestoreGateway {
  get(path: string): Promise<FirestoreDocument>;
  list(collectionPath: string): Promise<FirestoreDocument[]>;
  set(path: string, data: Record<string, unknown>, merge?: boolean): Promise<void>;
  update(path: string, data: Record<string, unknown>): Promise<void>;
  delete(path: string): Promise<void>;
  runTransaction<T>(fn: (transaction: FirestoreTransaction) => Promise<T>): Promise<T>;
  listMemoryPage?(collectionPath: string, options: {
    from: string | null;
    to: string;
    after: { created_at: string; id: string } | null;
    limit: number;
  }): Promise<FirestoreDocument[]>;
}

export interface FirestoreProjectRecord extends ProjectRecord {
  revision: number;
}

export interface MemoryIndexPageResult {
  items: MemoryIndexRecord[];
  next: { created_at: string; id: string } | null;
}

export interface MemoryIndexRecord {
  id: string;
  project_id: string;
  name: string;
  type: MemoryType;
  description: string;
  body_chars: number;
  content_key: string;
  content_hash: string;
  tags: string[];
  links: string[];
  supersedes: string[];
  entities: Entity[];
  triples: Triple[];
  status?: MemoryStatus;
  last_reviewed_at?: string;
  next_review_at?: string;
  archived_at?: string;
  archive_reason?: string;
  archived_by?: string;
  created_at: string;
  updated_at: string;
}

export interface NameIndexRecord {
  memory_id: string;
  name: string;
  content_key: string;
  content_hash: string;
}

export interface TombstoneRecord {
  project_id: string;
  memory_id: string;
  content_key: string;
  deleted_at: string;
}

export class FirestoreDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirestoreDataError';
  }
}

/**
 * Firestore rejects `undefined` values, while optional record fields are carried as
 * `undefined` in memory. Drop them before writing so an absent field stays absent.
 */
export function withoutUndefined(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    result[key] = isPlainObject(value) ? withoutUndefined(value) : value;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export class AdminFirestoreGateway implements FirestoreGateway {
  constructor(private readonly firestore: Firestore) {}

  async get(path: string): Promise<FirestoreDocument> {
    return this.snapshot(await this.firestore.doc(path).get());
  }

  async list(collectionPath: string): Promise<FirestoreDocument[]> {
    const snapshot = await this.firestore.collection(collectionPath).get();
    return snapshot.docs.map((doc) => this.snapshot(doc));
  }

  async listMemoryPage(collectionPath: string, options: {
    from: string | null;
    to: string;
    after: { created_at: string; id: string } | null;
    limit: number;
  }): Promise<FirestoreDocument[]> {
    let query = this.firestore.collection(collectionPath)
      .where('created_at', '<', options.to)
      .orderBy('created_at', 'asc')
      .orderBy(FieldPath.documentId(), 'asc');
    if (options.from !== null) query = query.where('created_at', '>=', options.from);
    if (options.after) query = query.startAfter(options.after.created_at, options.after.id);
    const snapshot = await query.limit(options.limit).get();
    return snapshot.docs.map((document) => this.snapshot(document));
  }

  async set(path: string, data: Record<string, unknown>, merge = false): Promise<void> {
    await this.firestore.doc(path).set(withoutUndefined(data), { merge });
  }

  async update(path: string, data: Record<string, unknown>): Promise<void> {
    await this.firestore.doc(path).update(withoutUndefined(data));
  }

  async delete(path: string): Promise<void> {
    await this.firestore.doc(path).delete();
  }

  async runTransaction<T>(fn: (transaction: FirestoreTransaction) => Promise<T>): Promise<T> {
    return this.firestore.runTransaction(async (transaction) => fn(new AdminFirestoreTransaction(transaction, this.firestore)));
  }

  private snapshot(document: { id: string; ref: { path: string }; exists: boolean; data(): Record<string, unknown> | undefined }): FirestoreDocument {
    return {
      id: document.id,
      path: document.ref.path,
      exists: document.exists,
      data: () => document.data(),
    };
  }
}

class AdminFirestoreTransaction implements FirestoreTransaction {
  constructor(private readonly transaction: Transaction, private readonly firestore: Firestore) {}

  async get(path: string): Promise<FirestoreDocument> {
    const document = await this.transaction.get(this.firestore.doc(path));
    return {
      id: document.id,
      path: document.ref.path,
      exists: document.exists,
      data: () => document.data(),
    };
  }

  async list(collectionPath: string): Promise<FirestoreDocument[]> {
    const snapshot = await this.transaction.get(this.firestore.collection(collectionPath));
    return snapshot.docs.map((document) => ({
      id: document.id,
      path: document.ref.path,
      exists: document.exists,
      data: () => document.data(),
    }));
  }

  set(path: string, data: Record<string, unknown>, merge = false): void {
    this.transaction.set(this.firestore.doc(path), withoutUndefined(data), { merge });
  }

  update(path: string, data: Record<string, unknown>): void {
    this.transaction.update(this.firestore.doc(path), withoutUndefined(data));
  }

  delete(path: string): void {
    this.transaction.delete(this.firestore.doc(path));
  }
}

function documentPath(...parts: string[]): string {
  return parts.join('/');
}

function projectPath(projectId: string): string {
  return documentPath('projects', assertProjectId(projectId));
}

function membersPath(projectId: string): string {
  return documentPath(projectPath(projectId), 'members');
}

function memberDocumentPath(projectId: string, userId: string): string {
  if (userId.length === 0) throw new FirestoreDataError('userId must be a non-empty string');
  return documentPath(membersPath(projectId), encodeURIComponent(userId));
}

function memoriesPath(projectId: string): string {
  return documentPath(projectPath(projectId), 'memories');
}

function namesPath(projectId: string): string {
  return documentPath(projectPath(projectId), 'names');
}

function tombstonesPath(projectId: string): string {
  return documentPath(projectPath(projectId), 'tombstones');
}

function maintenancePath(projectId: string): string {
  return documentPath(projectPath(projectId), 'maintenance');
}

function maintenanceSettingsPath(projectId: string): string {
  return documentPath(maintenancePath(projectId), 'settings');
}

function maintenanceEventsPath(projectId: string): string {
  return documentPath(maintenancePath(projectId), 'events');
}

function maintenanceOperationsPath(projectId: string): string {
  return documentPath(maintenancePath(projectId), 'operations');
}

function maintenanceLinkObservationsPath(projectId: string): string {
  return documentPath(maintenancePath(projectId), 'linkObservations');
}

function linkObservationDocumentId(memoryId: string, dstName: string): string {
  return createHash('sha256').update(`${memoryId}\0${dstName}`, 'utf8').digest('hex');
}

function memoryRevisionsPath(projectId: string, memoryId: string): string {
  return documentPath(memoriesPath(projectId), memoryId, 'revisions');
}

function safeDocumentId(value: string): string {
  if (value.length === 0 || value.includes('/')) throw new FirestoreDataError('document id must be non-empty and contain no slash');
  return encodeURIComponent(value);
}

function nameDocumentId(name: string): string {
  return encodeURIComponent(assertMemoryName(name));
}

function tombstoneDocumentId(contentKey: string): string {
  return createHash('sha256').update(contentKey, 'utf8').digest('hex');
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FirestoreDataError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new FirestoreDataError(`${context} must be a non-empty string`);
  return value;
}

function asNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new FirestoreDataError(`${context} must be an integer`);
  return value;
}

function asStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some((item) => typeof item !== 'string')) {
    throw new FirestoreDataError(`${context} must be a bounded string array`);
  }
  return [...value] as string[];
}

function asEntities(value: unknown): Entity[] {
  if (!Array.isArray(value) || value.length > 1000) throw new FirestoreDataError('entities must be a bounded array');
  return value.map((item, index) => {
    const entity = asRecord(item, `entities[${index}]`);
    return {
      name: asString(entity.name, `entities[${index}].name`),
      aliases: asStringArray(entity.aliases ?? [], `entities[${index}].aliases`),
    };
  });
}

function asTriples(value: unknown): Triple[] {
  if (!Array.isArray(value) || value.length > 1000) throw new FirestoreDataError('triples must be a bounded array');
  return value.map((item, index) => {
    if (!Array.isArray(item) || item.length !== 3 || item.some((part) => typeof part !== 'string')) {
      throw new FirestoreDataError(`triples[${index}] must contain three strings`);
    }
    return item as Triple;
  });
}

function asIso(value: unknown, context: string): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  if (isTimestamp(value)) return value.toDate().toISOString();
  throw new FirestoreDataError(`${context} must be an ISO timestamp`);
}

function isTimestamp(value: unknown): value is { toDate(): Date } {
  return typeof value === 'object' && value !== null && 'toDate' in value && typeof value.toDate === 'function';
}

function projectRecord(document: FirestoreDocument): FirestoreProjectRecord {
  const data = asRecord(document.data(), document.path);
  return {
    project_id: asString(data.project_id, `${document.path}.project_id`),
    owner_user_id: asString(data.owner_user_id, `${document.path}.owner_user_id`),
    created_at: asIso(data.created_at, `${document.path}.created_at`),
    updated_at: asIso(data.updated_at, `${document.path}.updated_at`),
    revision: asNumber(data.revision ?? 0, `${document.path}.revision`),
  };
}

function memberRecord(document: FirestoreDocument): MemberRecord {
  const data = asRecord(document.data(), document.path);
  const role = asString(data.role, `${document.path}.role`);
  if (role !== 'owner' && role !== 'member') throw new FirestoreDataError(`${document.path}.role is invalid`);
  return {
    project_id: asString(data.project_id, `${document.path}.project_id`),
    user_id: asString(data.user_id, `${document.path}.user_id`),
    role,
  };
}

function memoryRecord(document: FirestoreDocument): MemoryIndexRecord {
  const data = asRecord(document.data(), document.path);
  const type = asString(data.type, `${document.path}.type`) as MemoryType;
  if (!['user', 'feedback', 'project', 'reference', 'session'].includes(type)) {
    throw new FirestoreDataError(`${document.path}.type is invalid`);
  }
  const status = data.status ?? 'active';
  if (status !== 'active' && status !== 'archived') throw new FirestoreDataError(`${document.path}.status is invalid`);
  return {
    id: asString(data.id, `${document.path}.id`),
    project_id: asString(data.project_id, `${document.path}.project_id`),
    name: asString(data.name, `${document.path}.name`),
    type,
    description: typeof data.description === 'string' ? data.description : '',
    body_chars: asNumber(data.body_chars, `${document.path}.body_chars`),
    content_key: asString(data.content_key, `${document.path}.content_key`),
    content_hash: asString(data.content_hash, `${document.path}.content_hash`),
    tags: asStringArray(data.tags ?? [], `${document.path}.tags`),
    links: asStringArray(data.links ?? [], `${document.path}.links`),
    supersedes: asStringArray(data.supersedes ?? [], `${document.path}.supersedes`),
    entities: asEntities(data.entities ?? []),
    triples: asTriples(data.triples ?? []),
    status,
    last_reviewed_at: data.last_reviewed_at === undefined ? undefined : asIso(data.last_reviewed_at, `${document.path}.last_reviewed_at`),
    next_review_at: data.next_review_at === undefined ? undefined : asIso(data.next_review_at, `${document.path}.next_review_at`),
    archived_at: data.archived_at === undefined ? undefined : asIso(data.archived_at, `${document.path}.archived_at`),
    archive_reason: data.archive_reason === undefined ? undefined : asString(data.archive_reason, `${document.path}.archive_reason`),
    archived_by: data.archived_by === undefined ? undefined : asString(data.archived_by, `${document.path}.archived_by`),
    created_at: asIso(data.created_at, `${document.path}.created_at`),
    updated_at: asIso(data.updated_at, `${document.path}.updated_at`),
  };
}

function tokenRecord(document: FirestoreDocument): TokenRecord {
  const data = asRecord(document.data(), document.path);
  if (data.audience !== 'mcp') throw new FirestoreDataError(`${document.path}.audience is invalid`);
  return {
    id: asString(data.id, `${document.path}.id`),
    user_id: asString(data.user_id, `${document.path}.user_id`),
    token_hash: asString(data.token_hash, `${document.path}.token_hash`),
    token_prefix: asString(data.token_prefix, `${document.path}.token_prefix`),
    label: asString(data.label, `${document.path}.label`),
    audience: 'mcp',
    created_at: asIso(data.created_at, `${document.path}.created_at`),
    last_used_at: data.last_used_at === null ? null : asIso(data.last_used_at, `${document.path}.last_used_at`),
    expires_at: data.expires_at === null ? null : asIso(data.expires_at, `${document.path}.expires_at`),
    revoked_at: data.revoked_at === null ? null : asIso(data.revoked_at, `${document.path}.revoked_at`),
  };
}

function tombstoneRecord(document: FirestoreDocument): TombstoneRecord {
  const data = asRecord(document.data(), document.path);
  return {
    project_id: asString(data.project_id, `${document.path}.project_id`),
    memory_id: asString(data.memory_id, `${document.path}.memory_id`),
    content_key: asString(data.content_key, `${document.path}.content_key`),
    deleted_at: asIso(data.deleted_at, `${document.path}.deleted_at`),
  };
}

function nameRecord(document: FirestoreDocument): NameIndexRecord {
  const data = asRecord(document.data(), document.path);
  return {
    memory_id: asString(data.memory_id, `${document.path}.memory_id`),
    name: asString(data.name, `${document.path}.name`),
    content_key: asString(data.content_key, `${document.path}.content_key`),
    content_hash: asString(data.content_hash, `${document.path}.content_hash`),
  };
}

function settingsRecord(document: FirestoreDocument): MaintenanceSettings {
  const data = asRecord(document.data(), document.path);
  return MaintenanceSettingsSchema.parse({
    enabled: data.enabled,
    review_days: data.review_days,
    session_archive_days: data.session_archive_days,
    version: data.version,
  });
}

function revisionRecord(document: FirestoreDocument): MemoryRevision {
  const data = asRecord(document.data(), document.path);
  return {
    id: asString(data.id, `${document.path}.id`),
    memory_id: asString(data.memory_id, `${document.path}.memory_id`),
    content_key: asString(data.content_key, `${document.path}.content_key`),
    content_hash: asString(data.content_hash, `${document.path}.content_hash`),
    created_at: asIso(data.created_at, `${document.path}.created_at`),
    operation_id: asString(data.operation_id, `${document.path}.operation_id`),
    reason_code: asString(data.reason_code, `${document.path}.reason_code`) as MemoryRevision['reason_code'],
  };
}

function maintenanceEventRecord(document: FirestoreDocument): MaintenanceEvent {
  const data = asRecord(document.data(), document.path);
  return {
    operation_id: asString(data.operation_id, `${document.path}.operation_id`),
    project_id: asString(data.project_id, `${document.path}.project_id`),
    memory_ids: asStringArray(data.memory_ids, `${document.path}.memory_ids`),
    revision_ids: asStringArray(data.revision_ids, `${document.path}.revision_ids`),
    action: asString(data.action, `${document.path}.action`) as MaintenanceEvent['action'],
    reason_code: asString(data.reason_code, `${document.path}.reason_code`) as MaintenanceEvent['reason_code'],
    created_at: asIso(data.created_at, `${document.path}.created_at`),
  };
}

function linkObservationRecord(document: FirestoreDocument): LinkObservation {
  const data = asRecord(document.data(), document.path);
  return {
    memory_id: asString(data.memory_id, `${document.path}.memory_id`),
    dst_name: asString(data.dst_name, `${document.path}.dst_name`),
    first_seen_at: asIso(data.first_seen_at, `${document.path}.first_seen_at`),
  };
}

function memoryData(record: MemoryIndexRecord): Record<string, unknown> {
  return { ...record };
}

export class FirestoreMetadataStore {
  constructor(private readonly gateway: FirestoreGateway) {}

  async getMaintenanceSettings(projectId: string): Promise<MaintenanceSettings> {
    const document = await this.gateway.get(maintenanceSettingsPath(projectId));
    return document.exists ? settingsRecord(document) : { ...DEFAULT_MAINTENANCE_SETTINGS, review_days: { ...DEFAULT_MAINTENANCE_SETTINGS.review_days } };
  }

  async saveMaintenanceSettings(projectId: string, input: MaintenanceSettings, expectedVersion: number): Promise<MaintenanceSettings> {
    const settings = MaintenanceSettingsSchema.parse(input);
    const path = maintenanceSettingsPath(projectId);
    return this.gateway.runTransaction(async (transaction) => {
      const document = await transaction.get(path);
      const current = document.exists ? settingsRecord(document) : DEFAULT_MAINTENANCE_SETTINGS;
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || current.version !== expectedVersion) {
        throw new MemoryConflictError(`maintenance settings version: ${projectId}`);
      }
      const next = { ...settings, version: current.version + 1 };
      await transaction.set(path, next);
      return next;
    });
  }

  async listMaintenanceEvents(projectId: string, after?: string, limit = 100): Promise<MaintenanceEvent[]> {
    const bounded = Math.min(500, Math.max(1, Math.floor(limit)));
    const cursor = after ? decodeMaintenanceEventCursor(after) : null;
    const events = (await this.gateway.list(maintenanceEventsPath(projectId)))
      .filter((document) => document.exists)
      .map(maintenanceEventRecord)
      .filter((event) => cursor === null || event.created_at < cursor.created_at
        || (event.created_at === cursor.created_at && event.operation_id < cursor.operation_id))
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.operation_id.localeCompare(left.operation_id));
    return events.slice(0, bounded);
  }

  async getMaintenanceLinkObservation(projectId: string, memoryId: string, dstName: string): Promise<LinkObservation | null> {
    const path = documentPath(maintenanceLinkObservationsPath(projectId), linkObservationDocumentId(memoryId, dstName));
    const document = await this.gateway.get(path);
    return document.exists ? linkObservationRecord(document) : null;
  }

  async observeMaintenanceLinkIfAbsent(
    projectId: string,
    memoryId: string,
    dstName: string,
    firstSeenAt: string,
  ): Promise<LinkObservation> {
    const path = documentPath(maintenanceLinkObservationsPath(projectId), linkObservationDocumentId(memoryId, dstName));
    const parsedTime = new Date(firstSeenAt);
    if (Number.isNaN(parsedTime.getTime())) throw new Error('link observation timestamp must be valid');
    return this.gateway.runTransaction(async (transaction) => {
      const document = await transaction.get(path);
      if (document.exists) return linkObservationRecord(document);
      const record = { memory_id: memoryId, dst_name: dstName, first_seen_at: parsedTime.toISOString() };
      await transaction.set(path, record);
      return record;
    });
  }

  async clearMaintenanceLinkObservation(projectId: string, memoryId: string, dstName: string): Promise<void> {
    const path = documentPath(maintenanceLinkObservationsPath(projectId), linkObservationDocumentId(memoryId, dstName));
    await this.gateway.delete(path);
  }

  async listMemoryRevisions(projectId: string, memoryId: string): Promise<MemoryRevision[]> {
    return (await this.gateway.list(memoryRevisionsPath(projectId, memoryId)))
      .filter((document) => document.exists)
      .map(revisionRecord)
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
  }

  async getMaintenanceOperation(projectId: string, operationId: string, payloadHash: string): Promise<MutationResult | null> {
    const path = documentPath(maintenanceOperationsPath(projectId), safeDocumentId(operationId));
    const document = await this.gateway.get(path);
    if (!document.exists) return null;
    const data = asRecord(document.data(), path);
    return {
      operation_id: operationId,
      outcome: data.payload_hash === payloadHash ? 'already_applied' : 'conflict',
      memory_ids: asStringArray(data.memory_ids, `${path}.memory_ids`),
      revision_ids: asStringArray(data.revision_ids, `${path}.revision_ids`),
    };
  }

  async getMemoryRevision(projectId: string, memoryId: string, revisionId: string): Promise<MemoryRevision | null> {
    const document = await this.gateway.get(documentPath(memoryRevisionsPath(projectId, memoryId), safeDocumentId(revisionId)));
    return document.exists ? revisionRecord(document) : null;
  }

  async deleteMemoryRevisions(projectId: string, memoryId: string): Promise<MemoryRevision[]> {
    const revisions = await this.listMemoryRevisions(projectId, memoryId);
    await this.gateway.runTransaction(async (transaction) => {
      for (const revision of revisions) {
        await transaction.delete(documentPath(memoryRevisionsPath(projectId, memoryId), safeDocumentId(revision.id)));
        await transaction.set(documentPath(tombstonesPath(projectId), tombstoneDocumentId(revision.content_key)), {
          project_id: projectId,
          memory_id: memoryId,
          content_key: revision.content_key,
          deleted_at: new Date().toISOString(),
        });
      }
    });
    return revisions;
  }

  async commitMemoryMutation(data: MutationCommitData, records: MemoryIndexRecord[]): Promise<MutationResult> {
    const projectId = assertProjectId(data.request.project_id);
    const operation = documentPath(maintenanceOperationsPath(projectId), safeDocumentId(data.request.operation_id));
    const event = documentPath(maintenanceEventsPath(projectId), safeDocumentId(data.event.operation_id));
    const recordById = new Map(records.map((record) => [record.id, record]));
    if (recordById.size !== data.after.length) throw new Error('mutation records do not match snapshots');
    return this.gateway.runTransaction(async (transaction) => {
      const projectPathValue = projectPath(projectId);
      const operationDocument = await transaction.get(operation);
      if (operationDocument.exists) {
        const prior = asRecord(operationDocument.data(), operation);
        return {
          operation_id: data.request.operation_id,
          outcome: prior.payload_hash === data.payload_hash ? 'already_applied' : 'conflict',
          memory_ids: asStringArray(prior.memory_ids, `${operation}.memory_ids`),
          revision_ids: asStringArray(prior.revision_ids, `${operation}.revision_ids`),
        } satisfies MutationResult;
      }

      const projectDocument = await transaction.get(projectPathValue);
      if (!projectDocument.exists) throw new Error(`project not found: ${projectId}`);
      const currentProject = projectRecord(projectDocument);
      let settings: MaintenanceSettings | undefined;
      if (data.request.expected_settings_version !== undefined) {
        const settingsDocument = await transaction.get(maintenanceSettingsPath(projectId));
        settings = settingsDocument.exists ? settingsRecord(settingsDocument) : undefined;
        if (!settings?.enabled || settings.version !== data.request.expected_settings_version) return {
          operation_id: data.request.operation_id, outcome: 'conflict', memory_ids: [], revision_ids: [],
        };
      } else if (projectId !== '__shared__' && data.request.action.type !== 'restore') {
        return { operation_id: data.request.operation_id, outcome: 'conflict', memory_ids: [], revision_ids: [] };
      }

      if (data.request.max_active_memories !== undefined) {
        if (projectId !== '__shared__' || data.request.action.type !== 'create'
          || !Number.isSafeInteger(data.request.max_active_memories) || data.request.max_active_memories < 1) {
          return { operation_id: data.request.operation_id, outcome: 'conflict', memory_ids: [], revision_ids: [] };
        }
        const currentSharedMemories = await transaction.list(memoriesPath(projectId));
        const activeCount = currentSharedMemories.filter((document) => document.exists)
          .map(memoryRecord)
          .filter((record) => (record.status ?? 'active') === 'active').length;
        if (activeCount >= data.request.max_active_memories) {
          return { operation_id: data.request.operation_id, outcome: 'conflict', memory_ids: [], revision_ids: [] };
        }
      }

      const currentDocuments = new Map<string, FirestoreDocument>();
      for (const memoryId of Object.keys(data.before_hashes)) {
        const document = await transaction.get(documentPath(memoriesPath(projectId), safeDocumentId(memoryId)));
        currentDocuments.set(memoryId, document);
        if (!document.exists || memoryRecord(document).content_hash !== data.before_hashes[memoryId]) {
          return { operation_id: data.request.operation_id, outcome: 'conflict', memory_ids: [], revision_ids: [] };
        }
      }
      const currentRecords = new Map<string, MemoryIndexRecord>();
      for (const [memoryId, document] of currentDocuments) currentRecords.set(memoryId, memoryRecord(document));

      const nameDocuments = new Map<string, FirestoreDocument>();
      const namePaths = new Map<string, string>();
      for (const record of records) namePaths.set(record.name, documentPath(namesPath(projectId), nameDocumentId(record.name)));
      for (const current of currentRecords.values()) namePaths.set(current.name, documentPath(namesPath(projectId), nameDocumentId(current.name)));
      if (data.request.action.type === 'prune_links') {
        for (const name of data.request.action.names) namePaths.set(name, documentPath(namesPath(projectId), nameDocumentId(name)));
      }
      for (const [name, path] of namePaths) nameDocuments.set(name, await transaction.get(path));
      if (data.request.action.type === 'prune_links') {
        const currentMemory = currentRecords.get(data.request.action.memory_id);
        const nowMs = Date.parse(data.request.now);
        for (const name of data.request.action.names) {
          const observationPath = documentPath(maintenanceLinkObservationsPath(projectId), linkObservationDocumentId(data.request.action.memory_id, name));
          const observationDocument = await transaction.get(observationPath);
          const observation = observationDocument.exists ? linkObservationRecord(observationDocument) : null;
          const firstSeen = observation ? Date.parse(observation.first_seen_at) : Number.NaN;
          if (!currentMemory?.links.includes(name) || nameDocuments.get(name)?.exists
            || !Number.isFinite(nowMs) || !Number.isFinite(firstSeen)
            || nowMs - firstSeen < MISSING_LINK_GRACE_DAYS * 24 * 60 * 60 * 1000) {
            return { operation_id: data.request.operation_id, outcome: 'conflict', memory_ids: [], revision_ids: [] };
          }
        }
      }
      for (const record of records) {
        const existing = nameDocuments.get(record.name);
        if (existing?.exists && nameRecord(existing).memory_id !== record.id) {
          return { operation_id: data.request.operation_id, outcome: 'conflict', memory_ids: [], revision_ids: [] };
        }
      }

      for (const current of currentRecords.values()) {
        const next = recordById.get(current.id);
        if (next && current.name !== next.name) {
          const oldName = nameDocuments.get(current.name);
          if (oldName?.exists && nameRecord(oldName).memory_id === current.id) {
            await transaction.delete(documentPath(namesPath(projectId), nameDocumentId(current.name)));
          }
        }
      }
      for (const record of records) {
        await transaction.set(documentPath(memoriesPath(projectId), safeDocumentId(record.id)), memoryData(record));
        await transaction.set(documentPath(namesPath(projectId), nameDocumentId(record.name)), {
          memory_id: record.id,
          name: record.name,
          content_key: record.content_key,
          content_hash: record.content_hash,
        });
      }
      for (const revision of data.revisions) {
        await transaction.set(documentPath(memoryRevisionsPath(projectId, revision.memory_id), safeDocumentId(revision.id)), {
          ...revision,
          project_id: projectId,
        });
      }
      await transaction.set(event, { ...data.event });
      await transaction.set(operation, {
        operation_id: data.request.operation_id,
        payload_hash: data.payload_hash,
        outcome: 'applied',
        memory_ids: data.result.memory_ids,
        revision_ids: data.result.revision_ids,
        created_at: data.request.now,
      });
      await transaction.set(projectPathValue, {
        revision: currentProject.revision + 1,
        updated_at: data.request.now,
      }, true);
      return data.result;
    });
  }

  async getProject(projectId: string): Promise<FirestoreProjectRecord | null> {
    const document = await this.gateway.get(projectPath(projectId));
    return document.exists ? projectRecord(document) : null;
  }

  async createProject(projectId: string, ownerUserId: string, now = new Date().toISOString()): Promise<void> {
    const project = projectPath(projectId);
    const member = memberDocumentPath(projectId, ownerUserId);
    await this.gateway.runTransaction(async (transaction) => {
      if ((await transaction.get(project)).exists) throw new MemoryConflictError(projectId);
      await transaction.set(project, {
        project_id: assertProjectId(projectId),
        owner_user_id: ownerUserId,
        created_at: now,
        updated_at: now,
        revision: 0,
      });
      await transaction.set(member, { project_id: projectId, user_id: ownerUserId, role: 'owner' });
    });
  }

  async getMembership(projectId: string, userId: string): Promise<MemberRecord | null> {
    const document = await this.gateway.get(memberDocumentPath(projectId, userId));
    return document.exists ? memberRecord(document) : null;
  }

  async listAccessibleProjects(userId: string): Promise<Array<FirestoreProjectRecord & { role: 'owner' | 'member' }>> {
    const projects = await this.gateway.list('projects');
    const accessible = await Promise.all(projects.map(async (document) => {
      if (!document.exists) return null;
      const project = projectRecord(document);
      const member = await this.getMembership(project.project_id, userId);
      return member ? { ...project, role: member.role } : null;
    }));
    return accessible.filter((project): project is FirestoreProjectRecord & { role: 'owner' | 'member' } => project !== null)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.project_id.localeCompare(right.project_id));
  }

  async addMember(projectId: string, userId: string, role: 'owner' | 'member' = 'member'): Promise<void> {
    await this.gateway.set(memberDocumentPath(projectId, userId), { project_id: projectId, user_id: userId, role });
  }

  async removeMember(projectId: string, userId: string): Promise<void> {
    await this.gateway.delete(memberDocumentPath(projectId, userId));
  }

  async setMemberRole(projectId: string, userId: string, role: 'owner' | 'member'): Promise<void> {
    await this.gateway.update(memberDocumentPath(projectId, userId), { role });
  }

  async listMembers(projectId: string): Promise<MemberRecord[]> {
    const documents = await this.gateway.list(membersPath(projectId));
    return documents.filter((document) => document.exists).map(memberRecord).sort((left, right) => left.user_id.localeCompare(right.user_id));
  }

  async listProjects(): Promise<FirestoreProjectRecord[]> {
    return (await this.gateway.list('projects'))
      .filter((document) => document.exists)
      .map(projectRecord)
      .sort((left, right) => left.project_id.localeCompare(right.project_id));
  }

  async getMemoryIndex(projectId: string, memoryId: string): Promise<MemoryIndexRecord | null> {
    const document = await this.gateway.get(documentPath(memoriesPath(projectId), memoryId));
    return document.exists ? memoryRecord(document) : null;
  }

  async listMemoryIndexes(projectId: string): Promise<MemoryIndexRecord[]> {
    const documents = await this.gateway.list(memoriesPath(projectId));
    return documents.filter((document) => document.exists).map(memoryRecord).sort((left, right) => left.name.localeCompare(right.name));
  }

  async listMemoryIndexPage(
    projectId: string,
    options: { from: string | null; to: string; after: { created_at: string; id: string } | null; limit: number },
  ): Promise<MemoryIndexPageResult> {
    const bounded = Math.min(25, Math.max(1, Math.floor(options.limit)));
    if (!Number.isFinite(Date.parse(options.to))
      || (options.from !== null && (!Number.isFinite(Date.parse(options.from)) || options.from >= options.to))) {
      throw new FirestoreDataError('curation page window is invalid');
    }
    const collection = memoriesPath(assertProjectId(projectId));
    let documents: FirestoreDocument[];
    if (this.gateway.listMemoryPage) {
      documents = await this.gateway.listMemoryPage(collection, { ...options, limit: bounded + 1 });
    } else {
      documents = (await this.gateway.list(collection)).filter((document) => document.exists)
        .map(memoryRecord)
        .filter((record) => (options.from === null || record.created_at >= options.from)
          && record.created_at < options.to
          && (options.after === null || record.created_at > options.after.created_at
            || (record.created_at === options.after.created_at && record.id > options.after.id)))
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .slice(0, bounded + 1)
        .map((record) => ({
          id: record.id,
          path: documentPath(collection, record.id),
          exists: true,
          data: () => ({ ...record }),
        }));
    }
    const hasMore = documents.length > bounded;
    const items = documents.slice(0, bounded).map(memoryRecord);
    const last = items.at(-1);
    return { items, next: hasMore && last ? { created_at: last.created_at, id: last.id } : null };
  }

  async listNameIndexes(projectId: string): Promise<NameIndexRecord[]> {
    const documents = await this.gateway.list(namesPath(projectId));
    return documents.filter((document) => document.exists).map(nameRecord).sort((left, right) => left.name.localeCompare(right.name));
  }

  async getNameIndex(projectId: string, name: string): Promise<NameIndexRecord | null> {
    const document = await this.gateway.get(documentPath(namesPath(projectId), nameDocumentId(name)));
    return document.exists ? nameRecord(document) : null;
  }

  async putMemoryIndex(projectId: string, record: MemoryIndexRecord, expectedRevision?: number): Promise<void> {
    const project = projectPath(projectId);
    const memory = documentPath(memoriesPath(projectId), record.id);
    const name = documentPath(namesPath(projectId), nameDocumentId(record.name));
    await this.gateway.runTransaction(async (transaction) => {
      const projectDocument = await transaction.get(project);
      if (!projectDocument.exists) throw new Error(`project not found: ${projectId}`);
      const currentProject = projectRecord(projectDocument);
      if (expectedRevision !== undefined && currentProject.revision !== expectedRevision) {
        throw new MemoryConflictError(`project revision: ${projectId}`);
      }
      const existingName = await transaction.get(name);
      if (existingName.exists) {
        const existing = nameRecord(existingName);
        if (existing.memory_id !== record.id) throw new MemoryConflictError('memory name already exists');
      }
      await transaction.set(memory, memoryData(record));
      await transaction.set(name, {
        memory_id: record.id,
        name: record.name,
        content_key: record.content_key,
        content_hash: record.content_hash,
      });
      await transaction.set(project, { revision: currentProject.revision + 1, updated_at: record.updated_at }, true);
    });
  }

  async removeMemoryIndex(
    projectId: string,
    memoryId: string,
    expected: Pick<MemoryIndexRecord, 'content_key' | 'content_hash'>,
  ): Promise<void> {
    const project = projectPath(projectId);
    const memory = documentPath(memoriesPath(projectId), memoryId);
    await this.gateway.runTransaction(async (transaction) => {
      const projectDocument = await transaction.get(project);
      const memoryDocument = await transaction.get(memory);
      if (!memoryDocument.exists) return;
      const current = memoryRecord(memoryDocument);
      if (current.content_key !== expected.content_key || current.content_hash !== expected.content_hash) return;
      const name = documentPath(namesPath(projectId), nameDocumentId(current.name));
      const nameDocument = await transaction.get(name);
      if (nameDocument.exists) {
        const currentName = nameRecord(nameDocument);
        if (currentName.memory_id === memoryId
          && currentName.content_key === expected.content_key
          && currentName.content_hash === expected.content_hash) {
          await transaction.delete(name);
        }
      }
      await transaction.delete(memory);
      if (projectDocument.exists) {
        const currentProject = projectRecord(projectDocument);
        await transaction.set(project, { revision: currentProject.revision + 1 }, true);
      }
    });
  }

  async restoreMemoryIndex(
    projectId: string,
    record: MemoryIndexRecord,
    expected: Pick<MemoryIndexRecord, 'content_key' | 'content_hash'>,
  ): Promise<void> {
    const project = projectPath(projectId);
    const memory = documentPath(memoriesPath(projectId), record.id);
    const previousName = documentPath(namesPath(projectId), nameDocumentId(record.name));
    const tombstone = documentPath(tombstonesPath(projectId), tombstoneDocumentId(record.content_key));
    await this.gateway.runTransaction(async (transaction) => {
      const projectDocument = await transaction.get(project);
      const memoryDocument = await transaction.get(memory);
      const tombstoneDocument = await transaction.get(tombstone);
      if (!memoryDocument.exists) {
        if (!tombstoneDocument.exists) return;
        const currentTombstone = tombstoneRecord(tombstoneDocument);
        if (currentTombstone.memory_id !== record.id || currentTombstone.content_key !== record.content_key) return;
        const previousNameDocument = await transaction.get(previousName);
        if (previousNameDocument.exists) {
          const existing = nameRecord(previousNameDocument);
          if (existing.memory_id !== record.id) throw new MemoryConflictError('memory name already exists');
        }
        await transaction.set(memory, memoryData(record));
        await transaction.set(previousName, {
          memory_id: record.id,
          name: record.name,
          content_key: record.content_key,
          content_hash: record.content_hash,
        });
        await transaction.delete(tombstone);
        if (projectDocument.exists) {
          const currentProject = projectRecord(projectDocument);
          await transaction.set(project, { revision: currentProject.revision + 1 }, true);
        }
        return;
      }
      const current = memoryRecord(memoryDocument);
      if (current.content_key !== expected.content_key || current.content_hash !== expected.content_hash) return;
      const currentName = documentPath(namesPath(projectId), nameDocumentId(current.name));
      const currentNameDocument = await transaction.get(currentName);
      const previousNameDocument = currentName === previousName ? currentNameDocument : await transaction.get(previousName);
      if (previousNameDocument.exists) {
        const existing = nameRecord(previousNameDocument);
        if (existing.memory_id !== record.id) throw new MemoryConflictError('memory name already exists');
      }
      if (currentName !== previousName && currentNameDocument.exists) {
        const existing = nameRecord(currentNameDocument);
        if (existing.memory_id === record.id
          && existing.content_key === expected.content_key
          && existing.content_hash === expected.content_hash) {
          await transaction.delete(currentName);
        }
      }
      await transaction.set(memory, memoryData(record));
      await transaction.set(previousName, {
        memory_id: record.id,
        name: record.name,
        content_key: record.content_key,
        content_hash: record.content_hash,
      });
      if (projectDocument.exists) {
        const currentProject = projectRecord(projectDocument);
        await transaction.set(project, { revision: currentProject.revision + 1 }, true);
      }
    });
  }

  async restoreMemoryIndexes(
    projectId: string,
    previousRecords: MemoryIndexRecord[],
    currentRecords: MemoryIndexRecord[],
    tombstones: TombstoneRecord[],
  ): Promise<void> {
    const project = projectPath(projectId);
    const previousById = new Map(previousRecords.map((record) => [record.id, record]));
    const currentMemoryPaths = new Map(currentRecords.map((record) => [record.id, documentPath(memoriesPath(projectId), record.id)]));
    const currentNamePaths = new Map(currentRecords.map((record) => [record.name, documentPath(namesPath(projectId), nameDocumentId(record.name))]));
    const previousNamePaths = new Map(previousRecords.map((record) => [record.name, documentPath(namesPath(projectId), nameDocumentId(record.name))]));
    const tombstonePaths = tombstones.map((tombstone) => documentPath(tombstonesPath(projectId), tombstoneDocumentId(tombstone.content_key)));
    await this.gateway.runTransaction(async (transaction) => {
      const projectDocument = await transaction.get(project);
      const currentMemoryDocuments = new Map<string, FirestoreDocument>();
      const currentNameDocuments = new Map<string, FirestoreDocument>();
      const previousNameDocuments = new Map<string, FirestoreDocument>();
      for (const [id, path] of currentMemoryPaths) currentMemoryDocuments.set(id, await transaction.get(path));
      for (const [name, path] of currentNamePaths) currentNameDocuments.set(name, await transaction.get(path));
      for (const [name, path] of previousNamePaths) {
        if (!currentNamePaths.has(name)) previousNameDocuments.set(name, await transaction.get(path));
      }
      for (const record of currentRecords) {
        const memoryDocument = currentMemoryDocuments.get(record.id);
        if (!memoryDocument?.exists) throw new MemoryConflictError('memory restore conflict');
        const current = memoryRecord(memoryDocument);
        if (current.content_key !== record.content_key || current.content_hash !== record.content_hash) {
          throw new MemoryConflictError('memory restore conflict');
        }
        const nameDocument = currentNameDocuments.get(record.name);
        if (!nameDocument?.exists) throw new MemoryConflictError('memory restore conflict');
        const currentName = nameRecord(nameDocument);
        if (currentName.memory_id !== record.id
          || currentName.content_key !== record.content_key
          || currentName.content_hash !== record.content_hash) {
          throw new MemoryConflictError('memory restore conflict');
        }
      }
      for (const record of previousRecords) {
        const nameDocument = currentNameDocuments.get(record.name) ?? previousNameDocuments.get(record.name);
        if (nameDocument?.exists && nameRecord(nameDocument).memory_id !== record.id) {
          throw new MemoryConflictError('memory name already exists');
        }
      }
      for (const record of currentRecords) {
        const previous = previousById.get(record.id);
        if (!previous) {
          await transaction.delete(currentMemoryPaths.get(record.id)!);
          const nameDocument = currentNameDocuments.get(record.name);
          if (nameDocument?.exists) await transaction.delete(currentNamePaths.get(record.name)!);
          continue;
        }
        if (previous.name !== record.name) await transaction.delete(currentNamePaths.get(record.name)!);
      }
      for (const record of previousRecords) {
        await transaction.set(documentPath(memoriesPath(projectId), record.id), memoryData(record));
        await transaction.set(documentPath(namesPath(projectId), nameDocumentId(record.name)), {
          memory_id: record.id,
          name: record.name,
          content_key: record.content_key,
          content_hash: record.content_hash,
        });
      }
      for (const path of tombstonePaths) await transaction.delete(path);
      if (projectDocument.exists) {
        const currentProject = projectRecord(projectDocument);
        await transaction.set(project, { revision: currentProject.revision + 1 }, true);
      }
    });
  }

  async putTombstone(tombstone: TombstoneRecord): Promise<void> {
    await this.gateway.set(
      documentPath(tombstonesPath(tombstone.project_id), tombstoneDocumentId(tombstone.content_key)),
      { ...tombstone },
    );
  }

  async replaceMemoryIndexes(
    projectId: string,
    oldName: string,
    records: MemoryIndexRecord[],
    tombstones: TombstoneRecord[] = [],
  ): Promise<void> {
    const project = projectPath(projectId);
    const oldNamePath = documentPath(namesPath(projectId), nameDocumentId(oldName));
    const names = records.map((record) => ({
      record,
      memory: documentPath(memoriesPath(projectId), record.id),
      name: documentPath(namesPath(projectId), nameDocumentId(record.name)),
    }));
    await this.gateway.runTransaction(async (transaction) => {
      const projectDocument = await transaction.get(project);
      if (!projectDocument.exists) throw new Error(`project not found: ${projectId}`);
      const currentProject = projectRecord(projectDocument);
      for (const item of names) {
        const existingName = await transaction.get(item.name);
        if (existingName.exists) {
          const existing = nameRecord(existingName);
          if (existing.memory_id !== item.record.id) throw new MemoryConflictError('memory name already exists');
        }
      }
      if (!names.some((item) => item.name === oldNamePath)) await transaction.delete(oldNamePath);
      for (const item of names) {
        await transaction.set(item.memory, memoryData(item.record));
        await transaction.set(item.name, {
          memory_id: item.record.id,
          name: item.record.name,
          content_key: item.record.content_key,
          content_hash: item.record.content_hash,
        });
      }
      for (const tombstone of tombstones) {
        await transaction.set(
          documentPath(tombstonesPath(projectId), tombstoneDocumentId(tombstone.content_key)),
          { ...tombstone },
        );
      }
      const updatedAt = records.reduce((latest, record) => latest > record.updated_at ? latest : record.updated_at, currentProject.updated_at);
      await transaction.set(project, { revision: currentProject.revision + 1, updated_at: updatedAt }, true);
    });
  }

  async deleteMemoryIndex(projectId: string, memoryId: string, tombstone: TombstoneRecord): Promise<void> {
    const memory = documentPath(memoriesPath(projectId), memoryId);
    const tombstonePath = documentPath(tombstonesPath(projectId), tombstoneDocumentId(tombstone.content_key));
    await this.gateway.runTransaction(async (transaction) => {
      const memoryDocument = await transaction.get(memory);
      await transaction.set(tombstonePath, { ...tombstone });
      await transaction.delete(memory);
      if (memoryDocument.exists) {
        const current = memoryRecord(memoryDocument);
        await transaction.delete(documentPath(namesPath(projectId), nameDocumentId(current.name)));
      }
    });
  }

  async listTombstones(projectId: string): Promise<TombstoneRecord[]> {
    const documents = await this.gateway.list(tombstonesPath(projectId));
    return documents.filter((document) => document.exists).map(tombstoneRecord);
  }

  async clearTombstone(projectId: string, contentKey: string): Promise<void> {
    await this.gateway.delete(documentPath(tombstonesPath(projectId), tombstoneDocumentId(contentKey)));
  }

  async isTombstoned(projectId: string, contentKey: string): Promise<boolean> {
    const document = await this.gateway.get(documentPath(tombstonesPath(projectId), tombstoneDocumentId(contentKey)));
    return document.exists;
  }

  async insertToken(record: TokenRecord): Promise<void> {
    await this.gateway.set(documentPath('mcpTokens', record.token_hash), { ...record });
  }

  async findTokenByHash(hash: string): Promise<TokenRecord | null> {
    const document = await this.gateway.get(documentPath('mcpTokens', hash));
    return document.exists ? tokenRecord(document) : null;
  }

  async touchToken(id: string, timestamp = new Date().toISOString(), tokenHash?: string): Promise<void> {
    if (tokenHash) {
      const target = await this.gateway.get(documentPath('mcpTokens', tokenHash));
      if (target.exists && target.data()?.id === id) await this.gateway.update(target.path, { last_used_at: timestamp });
      return;
    }
    const documents = await this.gateway.list('mcpTokens');
    const target = documents.find((document) => document.exists && document.data()?.id === id);
    if (target) await this.gateway.update(target.path, { last_used_at: timestamp });
  }

  async revokeToken(userId: string, id: string, timestamp = new Date().toISOString()): Promise<boolean> {
    const documents = await this.gateway.list('mcpTokens');
    const target = documents.find((document) => document.exists && document.data()?.id === id && document.data()?.user_id === userId);
    if (!target) return false;
    await this.gateway.update(target.path, { revoked_at: timestamp });
    return true;
  }

  async listTokens(userId: string): Promise<Array<Omit<TokenRecord, 'token_hash'>>> {
    const tokens = (await this.gateway.list('mcpTokens'))
      .filter((document) => document.exists)
      .map(tokenRecord)
      .filter((token) => token.user_id === userId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    return tokens.map(({ token_hash, ...token }) => {
      void token_hash;
      return token;
    });
  }

  async listTokenHashes(): Promise<Array<Pick<TokenRecord, 'id' | 'user_id' | 'token_hash'>>> {
    return (await this.gateway.list('mcpTokens'))
      .filter((document) => document.exists)
      .map(tokenRecord)
      .map(({ id, user_id, token_hash }) => ({ id, user_id, token_hash }));
  }
}

export function createFirestoreMetadataStore(firestore: Firestore = getFirestore(getFirebaseAdminApp())): FirestoreMetadataStore {
  return new FirestoreMetadataStore(createFirestoreGateway(firestore));
}

export function createFirestoreGateway(firestore: Firestore = getFirestore(getFirebaseAdminApp())): FirestoreGateway {
  return new AdminFirestoreGateway(firestore);
}
