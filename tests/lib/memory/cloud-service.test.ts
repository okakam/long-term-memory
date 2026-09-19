import { afterEach, expect, test } from 'vitest';

import { openLocalDb } from '@/lib/storage/local-index';
import { KeyedMutex } from '@/lib/memory/mutex';
import { FirestoreMetadataStore, type FirestoreDocument, type FirestoreGateway, type FirestoreTransaction } from '@/lib/storage/firestore-metadata';
import { CloudMemoryService } from '@/lib/memory/cloud-service';
import type { IndexStore, MarkdownStore, SqlValue, StoredObject } from '@/lib/storage/contracts';

class FakeFirestore implements FirestoreGateway {
  readonly documents = new Map<string, Record<string, unknown>>();
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
    return fn({ get: (path) => this.get(path), set: (path, data, merge) => this.set(path, data, merge), update: (path, data) => this.update(path, data), delete: (path) => this.delete(path) });
  }
  private snapshot(path: string): FirestoreDocument {
    return { id: path.split('/').at(-1)!, path, exists: this.documents.has(path), data: () => this.documents.get(path) };
  }
}

class FakeMarkdownStore implements MarkdownStore {
  readonly objects = new Map<string, { text: string; updatedAt: Date }>();
  readonly removeFailures = new Set<string>();
  async read(key: string): Promise<string> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`missing object: ${key}`);
    return object.text;
  }
  async write(key: string, text: string): Promise<StoredObject> {
    const updatedAt = new Date();
    this.objects.set(key, { text, updatedAt });
    return { key, size: Buffer.byteLength(text), updatedAt };
  }
  async remove(key: string): Promise<void> {
    if (this.removeFailures.has(key)) throw new Error(`remove failed: ${key}`);
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

const resources: Array<{ close(): void }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) resource.close();
});

test('S3本文とFirestore metadataからsave/get/reindexを行いSQLite cacheを再構築できる', async () => {
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
    body: 'S3本文',
    tags: ['cloud'],
  });
  expect(await service.get('demo', saved.id)).toMatchObject({ id: saved.id, body: 'S3本文' });
  expect((await metadata.listMemoryIndexes('demo'))).toHaveLength(1);

  await index.exec('DELETE FROM memories');
  await index.exec('DELETE FROM tags');
  await index.exec('DELETE FROM links');
  await index.exec('DELETE FROM supersedes');
  await index.exec('DELETE FROM entities');
  await index.exec('DELETE FROM memories_fts');
  await service.reindex('demo');

  await expect(service.get('demo', 'cloud-note')).resolves.toMatchObject({ body: 'S3本文' });
  await expect(service.searchFulltext('demo', 'Cloud')).resolves.toHaveLength(1);
});

test('設定したS3 prefixを本文キーに使う', async () => {
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

test('新しいCloud Run instanceは最初のread前にS3からSQLite cacheを再構築する', async () => {
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

test('renameで旧S3 objectの削除に失敗した場合もFirestore tombstoneを残す', async () => {
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

test('renameで旧S3 objectの削除に成功した場合はFirestore tombstoneを消す', async () => {
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
