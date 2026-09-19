import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';

import type { MemberRecord, ProjectRecord, TokenRecord } from '@/lib/auth/store';
import { getFirebaseAdminApp } from '@/lib/auth/firebase';
import { MemoryConflictError } from '@/lib/memory/types';
import type { Entity, MemoryType, Triple } from '@/lib/memory/types';
import { assertMemoryName, assertProjectId } from '@/lib/slug';

export interface FirestoreDocument {
  id: string;
  path: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface FirestoreTransaction {
  get(path: string): Promise<FirestoreDocument>;
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
}

export interface FirestoreProjectRecord extends ProjectRecord {
  revision: number;
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

class AdminFirestoreGateway implements FirestoreGateway {
  constructor(private readonly firestore: Firestore) {}

  async get(path: string): Promise<FirestoreDocument> {
    return this.snapshot(await this.firestore.doc(path).get());
  }

  async list(collectionPath: string): Promise<FirestoreDocument[]> {
    const snapshot = await this.firestore.collection(collectionPath).get();
    return snapshot.docs.map((doc) => this.snapshot(doc));
  }

  async set(path: string, data: Record<string, unknown>, merge = false): Promise<void> {
    await this.firestore.doc(path).set(data, { merge });
  }

  async update(path: string, data: Record<string, unknown>): Promise<void> {
    await this.firestore.doc(path).update(data);
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

  set(path: string, data: Record<string, unknown>, merge = false): void {
    this.transaction.set(this.firestore.doc(path), data, { merge });
  }

  update(path: string, data: Record<string, unknown>): void {
    this.transaction.update(this.firestore.doc(path), data);
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

function memoryData(record: MemoryIndexRecord): Record<string, unknown> {
  return { ...record };
}

export class FirestoreMetadataStore {
  constructor(private readonly gateway: FirestoreGateway) {}

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

  async touchToken(id: string, timestamp = new Date().toISOString()): Promise<void> {
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
  return new FirestoreMetadataStore(new AdminFirestoreGateway(firestore));
}
