import { afterEach, expect, test, vi } from 'vitest';

import { computeHash } from '@/lib/markdown/file-io';
import { DEFAULT_MAINTENANCE_SETTINGS } from '@/lib/maintenance/policy';
import { serializeMemory } from '@/lib/markdown/frontmatter';
import type { Memory } from '@/lib/memory/types';
import { openLocalDb } from '@/lib/storage/local-index';
import { KeyedMutex } from '@/lib/memory/mutex';
import { FirestoreMetadataStore, type FirestoreDocument, type FirestoreGateway, type FirestoreTransaction } from '@/lib/storage/firestore-metadata';
import { CloudMemoryService } from '@/lib/memory/cloud-service';
import type { IndexStore, MarkdownStore, SqlValue, StoredObject } from '@/lib/storage/contracts';

class FakeFirestore implements FirestoreGateway {
  readonly documents = new Map<string, Record<string, unknown>>();
  failNextTransaction = false;
  async get(path: string): Promise<FirestoreDocument> { return this.snapshot(path); }
  async list(collectionPath: string): Promise<FirestoreDocument[]> {
    const prefix = `${collectionPath}/`;
    return [...this.documents.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map((path) => this.snapshot(path));
  }
  async set(path: string, data: Record<string, unknown>, merge = false): Promise<void> {
    this.documents.set(path, merge && this.documents.has(path) ? { ...this.documents.get(path), ...data } : { ...data });
  }
  async update(path: string, data: Record<string, unknown>): Promise<void> { await this.set(path, data, true); }
  async delete(path: string): Promise<void> { this.documents.delete(path); }
  async runTransaction<T>(fn: (transaction: FirestoreTransaction) => Promise<T>): Promise<T> {
    if (this.failNextTransaction) {
      this.failNextTransaction = false;
      throw new Error('firestore transaction failed');
    }
    return fn({
      get: (path) => this.get(path),
      list: (collectionPath) => this.list(collectionPath),
      set: (path, data, merge) => this.set(path, data, merge),
      update: (path, data) => this.update(path, data),
      delete: (path) => this.delete(path),
    });
  }
  private snapshot(path: string): FirestoreDocument {
    const data = this.documents.get(path);
    return { id: path.split('/').at(-1)!, path, exists: data !== undefined, data: () => data };
  }
}

class FakeMarkdownStore implements MarkdownStore {
  readonly objects = new Map<string, { text: string; updatedAt: Date }>();
  readonly removeFailures = new Set<string>();
  removeAllFailures = false;
  failAfterWrites: number | null = null;
  async read(key: string): Promise<string> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`missing object: ${key}`);
    return object.text;
  }
  async write(key: string, text: string): Promise<StoredObject> {
    if (this.failAfterWrites !== null) {
      if (this.failAfterWrites === 0) throw new Error(`write failed: ${key}`);
      this.failAfterWrites -= 1;
    }
    const updatedAt = new Date();
    this.objects.set(key, { text, updatedAt });
    return { key, size: Buffer.byteLength(text), updatedAt };
  }
  async remove(key: string): Promise<void> {
    if (this.removeAllFailures || this.removeFailures.has(key)) throw new Error(`remove failed: ${key}`);
    this.objects.delete(key);
  }
  async list(prefix: string): Promise<StoredObject[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, object]) => ({ key, size: Buffer.byteLength(object.text), updatedAt: object.updatedAt }));
  }
}

class FailingTransactionIndex implements IndexStore {
  constructor(private readonly delegate: IndexStore) {}

  exec(sql: string, args?: readonly SqlValue[]): Promise<void> {
    return this.delegate.exec(sql, args);
  }

  query<T extends object>(sql: string, args?: readonly SqlValue[]): Promise<T[]> {
    return this.delegate.query<T>(sql, args);
  }

  async transaction<T>(): Promise<T> {
    throw new Error('cache transaction failed');
  }

  close(): void | Promise<void> {
    return this.delegate.close?.();
  }
}

class FailOnceTransactionIndex implements IndexStore {
  failNextTransaction = false;
  constructor(private readonly delegate: IndexStore) {}
  exec(sql: string, args?: readonly SqlValue[]): Promise<void> { return this.delegate.exec(sql, args); }
  query<T extends object>(sql: string, args?: readonly SqlValue[]): Promise<T[]> { return this.delegate.query<T>(sql, args); }
  async transaction<T>(fn: (store: IndexStore) => Promise<T>): Promise<T> {
    if (this.failNextTransaction) {
      this.failNextTransaction = false;
      throw new Error('cache transaction failed once');
    }
    return this.delegate.transaction(fn);
  }
  close(): void | Promise<void> { return this.delegate.close?.(); }
}

const resources: Array<{ close(): void }> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const resource of resources.splice(0)) resource.close();
});

test('CloudMemoryService save はURL出典を構造化しsource_refsと分離して保存する', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const service = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');

  const saved = await service.save('demo', {
    name: 'source-note', description: 'External source', type: 'reference',
    body: 'Reference text\n\nURL: https://example.test/doc?version=2',
    source_refs: [{ project_id: 'origin', memory: 'source-memory' }],
  });

  expect(saved).toMatchObject({
    sources: [{ kind: 'url', url: 'https://example.test/doc?version=2', captured_at: '2026-10-01T00:00:00.000Z' }],
    source_refs: [{ project_id: 'origin', memory: 'source-memory' }],
    last_reviewed_at: '2026-10-01T00:00:00.000Z',
    next_review_at: '2027-03-30T00:00:00.000Z',
  });
  expect(await service.get('demo', saved.id)).toMatchObject({ sources: saved.sources, source_refs: saved.source_refs });
});

test('maintenance cloud pages use canonical active records and Firestore link observations persist', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const firestore = new FakeFirestore();
  const metadata = new FirestoreMetadataStore(firestore);
  await metadata.createProject('demo', 'owner');
  const service = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');
  const first = await service.save('demo', { name: 'first-memory', description: 'first', type: 'project', body: 'First fact.' });
  const second = await service.save('demo', { name: 'second-memory', description: 'second', type: 'project', body: 'Second fact.' });
  const settings = await service.maintenanceStore.saveSettings('demo', { ...DEFAULT_MAINTENANCE_SETTINGS, enabled: true }, 0);

  const firstPage = await service.listMaintenanceMemories('demo', undefined, 1);
  expect(firstPage.items).toHaveLength(1);
  expect(firstPage.next_after).toBe(firstPage.items[0]!.memory.id);
  const secondPage = await service.listMaintenanceMemories('demo', firstPage.next_after ?? undefined, 1);
  expect(secondPage.items).toHaveLength(1);
  expect(secondPage.next_after).toBeNull();

  const secondRecord = await metadata.getMemoryIndex('demo', second.id);
  const archived = await service.applyMutationAsync({
    operation_id: 'archive-cloud-page-memory', project_id: 'demo',
    expected_hashes: { [second.id]: secondRecord!.content_hash }, expected_settings_version: settings.version,
    action: { type: 'archive', memory_id: second.id, archive_reason: 'completed' },
    reason_code: 'completed', now: '2026-10-12T00:00:00.000Z',
  });
  expect(archived.outcome).toBe('applied');
  expect((await service.listMaintenanceMemories('demo')).items.map((item) => item.memory.id)).toEqual([first.id]);
  await expect(service.getMaintenanceMemory('demo', second.id)).resolves.toMatchObject({ memory: { status: 'archived' } });
  await expect(service.maintenanceNameExists('demo', second.name)).resolves.toBe(true);

  const observation = await metadata.observeMaintenanceLinkIfAbsent('demo', first.id, 'future-memory', '2026-09-01T00:00:00.000Z');
  await expect(metadata.observeMaintenanceLinkIfAbsent('demo', first.id, 'future-memory', '2026-10-01T00:00:00.000Z'))
    .resolves.toEqual(observation);
  await metadata.clearMaintenanceLinkObservation('demo', first.id, 'future-memory');
  await expect(metadata.getMaintenanceLinkObservation('demo', first.id, 'future-memory')).resolves.toBeNull();

  const linkOwner = await service.save('demo', {
    name: 'link-owner', description: 'link owner', type: 'project', links: ['existing-target'], body: 'Keep resolved links.',
  });
  await service.save('demo', { name: 'existing-target', description: 'target', type: 'project', body: 'Target is present.' });
  await service.maintenanceStore.observeLinkIfAbsent('demo', linkOwner.id, 'existing-target', '2026-09-01T00:00:00.000Z');
  const linkOwnerRecord = await metadata.getMemoryIndex('demo', linkOwner.id);
  const prune = await service.applyMutationAsync({
    operation_id: 'cloud-cannot-prune-existing-target', project_id: 'demo',
    expected_hashes: { [linkOwner.id]: linkOwnerRecord!.content_hash }, expected_settings_version: settings.version,
    action: { type: 'prune_links', memory_id: linkOwner.id, names: ['existing-target'] },
    reason_code: 'missing_link', now: '2026-10-12T00:00:00.000Z',
  });
  expect(prune.outcome).toBe('conflict');
  await expect(service.get('demo', linkOwner.id)).resolves.toMatchObject({ links: ['existing-target'] });
});

test('CloudMemoryService mutation は旧GCS本文をrevisionへ保持し、current metadataを更新する', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const service = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');
  const saved = await service.save('demo', {
    name: 'revision-note', description: 'before', type: 'reference', body: 'before body',
  });
  const originalRecord = await metadata.getMemoryIndex('demo', saved.id);
  const settings = await service.maintenanceStore.saveSettings('demo', { ...DEFAULT_MAINTENANCE_SETTINGS, enabled: true }, 0);

  const request = {
    operation_id: 'cloud-patch', project_id: 'demo',
    expected_hashes: { [saved.id]: originalRecord!.content_hash }, expected_settings_version: settings.version,
    action: { type: 'patch' as const, memory_id: saved.id, patch: { body: 'after body' } },
    reason_code: 'confirmed' as const, now: '2026-10-12T00:00:00.000Z',
  };
  const result = await service.applyMutationAsync(request);

  expect(result.outcome).toBe('applied');
  expect(await service.get('demo', saved.id)).toMatchObject({ body: 'after body', status: 'active' });
  expect(await metadata.getMemoryIndex('demo', saved.id)).toMatchObject({ status: 'active', content_hash: expect.not.stringMatching(originalRecord!.content_hash) });
  expect(await service.listRevisionsAsync('demo', saved.id)).toMatchObject([
    { content_hash: originalRecord!.content_hash, operation_id: 'cloud-patch' },
  ]);
  expect(markdown.objects.get(originalRecord!.content_key)?.text).toContain('before body');

  expect((await service.applyMutationAsync(request)).outcome).toBe('already_applied');
  expect((await service.applyMutationAsync({ ...request, action: { ...request.action, patch: { body: 'different payload' } } })).outcome).toBe('conflict');

  const updatedRecord = await metadata.getMemoryIndex('demo', saved.id);
  const archived = await service.applyMutationAsync({
    operation_id: 'cloud-archive', project_id: 'demo', expected_hashes: { [saved.id]: updatedRecord!.content_hash },
    expected_settings_version: settings.version,
    action: { type: 'archive', memory_id: saved.id, archive_reason: 'completed' },
    reason_code: 'completed', now: '2026-10-12T00:01:00.000Z',
  });
  expect(archived.outcome).toBe('applied');
  expect(await service.listByType('demo', 'reference')).toEqual([]);
  expect(await service.searchFulltext('demo', 'after body')).toEqual([]);
  await service.reindex('demo');
  expect(await service.get('demo', saved.id)).toMatchObject({ status: 'archived' });
  expect(await service.listByType('demo', 'reference')).toEqual([]);
  const patchRevision = (await service.listRevisionsAsync('demo', saved.id)).find((revision) => revision.operation_id === 'cloud-patch')!;
  const archivedRecord = await metadata.getMemoryIndex('demo', saved.id);
  const restored = await service.applyMutationAsync({
    operation_id: 'cloud-restore', project_id: 'demo', expected_hashes: { [saved.id]: archivedRecord!.content_hash },
    action: { type: 'restore', memory_id: saved.id, revision_id: patchRevision.id },
    reason_code: 'restored', now: '2026-10-12T00:02:00.000Z',
  });
  expect(restored.outcome).toBe('applied');
  expect(await service.get('demo', saved.id)).toMatchObject({ status: 'active', body: 'before body' });
  const revisionKeys = (await service.listRevisionsAsync('demo', saved.id)).map((revision) => revision.content_key);
  await service.forget('demo', saved.id);
  expect(await service.listRevisionsAsync('demo', saved.id)).toEqual([]);
  expect(revisionKeys.every((key) => !markdown.objects.has(key))).toBe(true);
  await expect(service.applyMutationAsync({
    operation_id: 'cloud-restore-after-forget', project_id: 'demo', expected_hashes: {},
    action: { type: 'restore', memory_id: saved.id, revision_id: patchRevision.id },
    reason_code: 'restored', now: '2026-10-12T00:03:00.000Z',
  })).rejects.toThrow(`memory not found: ${saved.id}`);
});

test('Cloud mutation のGCS/Firestore失敗ではcurrent pointerを変えず未参照objectをcleanupする', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const firestore = new FakeFirestore();
  const metadata = new FirestoreMetadataStore(firestore);
  await metadata.createProject('demo', 'owner');
  const service = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');
  const saved = await service.save('demo', { name: 'failure-note', description: 'before', type: 'reference', body: 'before body' });
  const original = await metadata.getMemoryIndex('demo', saved.id);
  const settings = await service.maintenanceStore.saveSettings('demo', { ...DEFAULT_MAINTENANCE_SETTINGS, enabled: true }, 0);
  const request = {
    operation_id: 'failed-gcs-write', project_id: 'demo', expected_hashes: { [saved.id]: original!.content_hash },
    expected_settings_version: settings.version,
    action: { type: 'patch' as const, memory_id: saved.id, patch: { body: 'new body' } },
    reason_code: 'confirmed' as const, now: '2026-10-12T00:00:00.000Z',
  };

  markdown.failAfterWrites = 0;
  await expect(service.applyMutationAsync(request)).rejects.toThrow('write failed');
  expect((await metadata.getMemoryIndex('demo', saved.id))?.content_hash).toBe(original!.content_hash);
  expect(await service.listRevisionsAsync('demo', saved.id)).toEqual([]);

  markdown.failAfterWrites = null;
  firestore.failNextTransaction = true;
  await expect(service.applyMutationAsync({ ...request, operation_id: 'failed-firestore-commit' })).rejects.toThrow('firestore transaction failed');
  expect((await metadata.getMemoryIndex('demo', saved.id))?.content_hash).toBe(original!.content_hash);
  expect(await service.listRevisionsAsync('demo', saved.id)).toEqual([]);
  expect(markdown.objects.size).toBe(1);
  expect(await service.get('demo', saved.id)).toMatchObject({ body: 'before body' });
});

test('Cloud cache transaction failure rebuilds from committed Firestore current pointers', async () => {
  const delegate = openLocalDb(':memory:');
  const index = new FailOnceTransactionIndex(delegate);
  resources.push(delegate);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const service = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');
  const saved = await service.save('demo', { name: 'cache-failure', description: 'before', type: 'reference', body: 'before body' });
  const original = await metadata.getMemoryIndex('demo', saved.id);
  const settings = await service.maintenanceStore.saveSettings('demo', { ...DEFAULT_MAINTENANCE_SETTINGS, enabled: true }, 0);
  index.failNextTransaction = true;
  const result = await service.applyMutationAsync({
    operation_id: 'cache-commit-rebuild', project_id: 'demo', expected_hashes: { [saved.id]: original!.content_hash },
    expected_settings_version: settings.version,
    action: { type: 'patch', memory_id: saved.id, patch: { body: 'after body' } },
    reason_code: 'confirmed', now: '2026-10-12T00:00:00.000Z',
  });
  expect(result.outcome).toBe('applied');
  expect(await service.get('demo', saved.id)).toMatchObject({ body: 'after body' });
  expect(await service.listRevisionsAsync('demo', saved.id)).toHaveLength(1);
});

test('GCS本文とFirestore metadataからsave/get/reindexを行いSQLite cacheを再構築できる', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const service = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');

  const saved = await service.save('demo', {
    name: 'cloud-note',
    description: 'Cloud Run本文',
    type: 'reference',
    body: 'GCS本文',
    tags: ['cloud'],
  });
  expect(await service.get('demo', saved.id)).toMatchObject({ id: saved.id, body: 'GCS本文' });
  expect((await metadata.listMemoryIndexes('demo'))).toHaveLength(1);

  await index.exec('DELETE FROM memories');
  await index.exec('DELETE FROM tags');
  await index.exec('DELETE FROM links');
  await index.exec('DELETE FROM supersedes');
  await index.exec('DELETE FROM entities');
  await index.exec('DELETE FROM memories_fts');
  await service.reindex('demo');

  await expect(service.get('demo', 'cloud-note')).resolves.toMatchObject({ body: 'GCS本文' });
  await expect(service.searchFulltext('demo', 'Cloud')).resolves.toHaveLength(1);
});

test('設定したGCS prefixを本文キーに使う', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const service = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'custom-prefix');

  await service.save('demo', {
    name: 'prefixed-note',
    description: 'prefix',
    type: 'reference',
    body: '本文',
  });

  expect([...markdown.objects.keys()]).toHaveLength(1);
  expect([...markdown.objects.keys()][0]).toMatch(/^custom-prefix\/demo\/memories\/prefixed-note\/[a-f0-9]{64}\.md$/);
});

test('SQLite cache更新に失敗したsaveはFirestore metadataを残さない', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const service = new CloudMemoryService(Promise.resolve(new FailingTransactionIndex(index)), markdown, metadata, new KeyedMutex(), 'projects');

  await expect(service.save('demo', {
    name: 'cache-failure',
    description: 'rollback',
    type: 'reference',
    body: '保存失敗',
  })).rejects.toThrow('cache transaction failed');

  await expect(metadata.listMemoryIndexes('demo')).resolves.toHaveLength(0);
  expect(markdown.objects.size).toBe(0);
});

test('reindexはSQLite登録に失敗したmemoryのFirestore metadataを作成しない', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const invalidMemory: Memory = {
    id: '01J00000000000000000000001',
    name: 'invalid-reindex',
    description: '不正なKGを含むmemory',
    type: 'reference',
    tags: [],
    links: [],
    entities: [],
    triples: [['missing-subject', 'relates-to', 'missing-object']],
    supersedes: [],
    body: '本文',
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
  };
  const raw = serializeMemory(invalidMemory);
  const key = `projects/demo/memories/${invalidMemory.name}/${computeHash(raw)}.md`;
  markdown.objects.set(key, { text: raw, updatedAt: new Date() });
  const service = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');

  await service.reindex('demo');

  await expect(metadata.listMemoryIndexes('demo')).resolves.toHaveLength(0);
  await expect(index.query('SELECT id FROM memories WHERE project_id = ?', ['demo'])).resolves.toHaveLength(0);
});

test('SQLite cache更新に失敗したupdateはFirestore metadataを旧本文へ戻す', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const firstService = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');
  const saved = await firstService.save('demo', {
    name: 'update-rollback',
    description: 'before',
    type: 'reference',
    body: '旧本文',
  });
  const oldKey = [...markdown.objects.keys()][0];

  const failingService = new CloudMemoryService(Promise.resolve(new FailingTransactionIndex(index)), markdown, metadata, new KeyedMutex(), 'projects');
  await expect(failingService.update('demo', saved.id, { body: '新本文' })).rejects.toThrow('cache transaction failed');

  await expect(metadata.getMemoryIndex('demo', saved.id)).resolves.toMatchObject({ content_key: oldKey, content_hash: expect.any(String) });
  expect([...markdown.objects.keys()]).toEqual([oldKey]);
});

test('SQLite cache削除に失敗したforgetはFirestore metadataを復元する', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const firstService = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');
  const saved = await firstService.save('demo', {
    name: 'forget-rollback',
    description: 'before',
    type: 'reference',
    body: '削除前',
  });
  const oldKey = [...markdown.objects.keys()][0];

  const failingService = new CloudMemoryService(Promise.resolve(new FailingTransactionIndex(index)), markdown, metadata, new KeyedMutex(), 'projects');
  await expect(failingService.forget('demo', saved.id)).rejects.toThrow('cache transaction failed');

  await expect(metadata.getMemoryIndex('demo', saved.id)).resolves.toMatchObject({ content_key: oldKey });
  await expect(metadata.isTombstoned('demo', oldKey)).resolves.toBe(false);
  await expect(failingService.get('demo', saved.id)).resolves.toMatchObject({ body: '削除前' });
  expect(markdown.objects.has(oldKey)).toBe(true);
});

test('SQLite cache更新に失敗したrenameはFirestore metadataを旧nameへ戻す', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const firstService = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');
  const saved = await firstService.save('demo', {
    name: 'rename-rollback',
    description: 'before',
    type: 'reference',
    body: 'rename前',
  });
  const reference = await firstService.save('demo', {
    name: 'rename-reference',
    description: 'reference',
    type: 'reference',
    links: ['rename-rollback'],
    body: '参照元',
  });
  const oldKeys = [...markdown.objects.keys()];

  const failingService = new CloudMemoryService(Promise.resolve(new FailingTransactionIndex(index)), markdown, metadata, new KeyedMutex(), 'projects');
  await expect(failingService.rename('demo', 'rename-rollback', 'renamed')).rejects.toThrow('cache transaction failed');

  await expect(metadata.getNameIndex('demo', 'rename-rollback')).resolves.toMatchObject({ memory_id: saved.id });
  await expect(metadata.getNameIndex('demo', 'renamed')).resolves.toBeNull();
  await expect(metadata.isTombstoned('demo', oldKeys[0])).resolves.toBe(false);
  await expect(metadata.getMemoryIndex('demo', reference.id)).resolves.toMatchObject({ name: 'rename-reference', content_key: oldKeys[1] });
  await expect(failingService.get('demo', saved.id)).resolves.toMatchObject({ name: 'rename-rollback', body: 'rename前' });
  await expect(failingService.get('demo', reference.id)).resolves.toMatchObject({ links: ['rename-rollback'] });
  expect([...markdown.objects.keys()]).toEqual(oldKeys);
});

test('renameの部分書き込みとcleanup失敗は新objectへtombstoneを残す', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const service = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');
  await service.save('demo', { name: 'partial-rename', description: 'target', type: 'reference', body: '対象' });
  await service.save('demo', { name: 'partial-reference', description: 'ref', type: 'reference', links: ['partial-rename'], body: '参照' });
  const oldKeys = [...markdown.objects.keys()];
  markdown.failAfterWrites = 1;
  markdown.removeAllFailures = true;

  await expect(service.rename('demo', 'partial-rename', 'partial-renamed')).rejects.toThrow('write failed');

  const newKey = [...markdown.objects.keys()].find((key) => !oldKeys.includes(key));
  expect(newKey).toBeDefined();
  await expect(metadata.isTombstoned('demo', newKey!)).resolves.toBe(true);
});

test('新しいCloud Run instanceは最初のread前にGCSからSQLite cacheを再構築する', async () => {
  const firstIndex = openLocalDb(':memory:');
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const firstService = new CloudMemoryService(Promise.resolve(firstIndex), markdown, metadata, new KeyedMutex(), 'projects');
  const saved = await firstService.save('demo', {
    name: 'restart-note',
    description: 'restart',
    type: 'reference',
    body: '再起動後も取得',
  });
  firstIndex.close();

  const secondIndex = openLocalDb(':memory:');
  resources.push(secondIndex);
  let resolveIndex!: (store: IndexStore) => void;
  const indexPromise = new Promise<IndexStore>((resolve) => { resolveIndex = resolve; });
  const secondService = new CloudMemoryService(indexPromise, markdown, metadata, new KeyedMutex(), 'projects', true);
  const reindex = secondService.reindex('demo').then(() => true);
  resolveIndex(secondIndex);
  await expect(Promise.race([
    reindex,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('startup reindex deadlocked')), 100)),
  ])).resolves.toBe(true);
  await expect(secondService.get('demo', saved.id)).resolves.toMatchObject({ name: 'restart-note', body: '再起動後も取得' });
  await expect(secondService.searchFulltext('demo', '再起動後')).resolves.toHaveLength(1);
});

test('renameはFirestore name indexと参照先を更新する', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const service = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');

  await service.save('demo', {
    name: 'old-name',
    description: 'old',
    type: 'reference',
    body: '対象',
  });
  const reference = await service.save('demo', {
    name: 'reference',
    description: 'ref',
    type: 'reference',
    links: ['old-name'],
    body: '参照',
  });

  await service.rename('demo', 'old-name', 'new-name');

  await expect(metadata.getNameIndex('demo', 'old-name')).resolves.toBeNull();
  await expect(metadata.getNameIndex('demo', 'new-name')).resolves.toMatchObject({ name: 'new-name' });
  await expect(service.get('demo', reference.id)).resolves.toMatchObject({ links: ['new-name'] });
});

test('renameで旧GCS objectの削除に失敗した場合もFirestore tombstoneを残す', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const service = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');

  await service.save('demo', { name: 'old-name', description: 'old', type: 'reference', body: '対象' });
  const oldKey = [...markdown.objects.keys()][0];
  markdown.removeFailures.add(oldKey);

  await service.rename('demo', 'old-name', 'new-name');

  await expect(metadata.isTombstoned('demo', oldKey)).resolves.toBe(true);
});

test('renameで旧GCS objectの削除に成功した場合はFirestore tombstoneを消す', async () => {
  const index = openLocalDb(':memory:');
  resources.push(index);
  const markdown = new FakeMarkdownStore();
  const metadata = new FirestoreMetadataStore(new FakeFirestore());
  await metadata.createProject('demo', 'owner');
  const service = new CloudMemoryService(Promise.resolve(index), markdown, metadata, new KeyedMutex(), 'projects');

  await service.save('demo', { name: 'old-name', description: 'old', type: 'reference', body: '対象' });
  const oldKey = [...markdown.objects.keys()][0];
  await service.rename('demo', 'old-name', 'new-name');

  await expect(metadata.isTombstoned('demo', oldKey)).resolves.toBe(false);
});
