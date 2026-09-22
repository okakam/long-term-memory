import { afterEach, describe, expect, test } from 'vitest';

import type {
  FirestoreDocument,
  FirestoreGateway,
  FirestoreTransaction,
  MemoryIndexRecord,
} from '@/lib/storage/firestore-metadata';
import {
  FirestoreDataError,
  FirestoreMetadataStore,
  type TombstoneRecord,
} from '@/lib/storage/firestore-metadata';

class FakeFirestore implements FirestoreGateway {
  readonly documents = new Map<string, Record<string, unknown>>();
  private transactionDepth = 0;

  async get(path: string): Promise<FirestoreDocument> {
    return this.snapshot(path);
  }

  async list(collectionPath: string): Promise<FirestoreDocument[]> {
    const prefix = `${collectionPath}/`;
    return [...this.documents.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path]) => this.snapshot(path));
  }

  async set(path: string, data: Record<string, unknown>, merge = false): Promise<void> {
    const previous = this.documents.get(path);
    this.documents.set(path, merge && previous ? { ...previous, ...data } : { ...data });
  }

  async update(path: string, data: Record<string, unknown>): Promise<void> {
    if (!this.documents.has(path)) throw new Error(`missing document: ${path}`);
    await this.set(path, data, true);
  }

  async delete(path: string): Promise<void> {
    this.documents.delete(path);
  }

  async runTransaction<T>(fn: (transaction: FirestoreTransaction) => Promise<T>): Promise<T> {
    if (this.transactionDepth > 0) throw new Error('nested transaction');
    this.transactionDepth += 1;
    try {
      const transaction: FirestoreTransaction = {
        get: (path) => this.get(path),
        list: (collectionPath) => this.list(collectionPath),
        set: (path, data, merge) => this.set(path, data, merge),
        update: (path, data) => this.update(path, data),
        delete: (path) => this.delete(path),
      };
      return await fn(transaction);
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private snapshot(path: string): FirestoreDocument {
    const data = this.documents.get(path);
    return {
      id: path.split('/').at(-1)!,
      path,
      exists: data !== undefined,
      data: () => data,
    };
  }
}

const stores: FirestoreMetadataStore[] = [];

afterEach(() => {
  stores.splice(0);
});

function record(overrides: Partial<MemoryIndexRecord> = {}): MemoryIndexRecord {
  return {
    id: 'memory-1',
    project_id: 'demo',
    name: 'note',
    type: 'reference',
    description: '説明',
    body_chars: 3,
    content_key: 'projects/demo/memories/note/hash.md',
    content_hash: 'a'.repeat(64),
    tags: ['tag'],
    links: [],
    supersedes: [],
    entities: [],
    triples: [],
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('FirestoreMetadataStore', () => {
  test('save transactionはmemoryとname indexを同時に作成する', async () => {
    const store = new FirestoreMetadataStore(new FakeFirestore());
    stores.push(store);
    await store.createProject('demo', 'owner');
    await store.putMemoryIndex('demo', record());

    expect(await store.getMemoryIndex('demo', 'memory-1')).toEqual(record());
    expect(await store.getNameIndex('demo', 'note')).toMatchObject({ memory_id: 'memory-1' });
    expect((await store.getProject('demo'))?.revision).toBe(1);
  });

  test('同一projectのname重複はMemoryConflictErrorになる', async () => {
    const store = new FirestoreMetadataStore(new FakeFirestore());
    stores.push(store);
    await store.createProject('demo', 'owner');
    await store.putMemoryIndex('demo', record());
    await expect(store.putMemoryIndex('demo', record({ id: 'memory-2' })))
      .rejects.toThrow('memory name already exists');
  });

  test('削除transactionはtombstoneを残しmemory/nameを削除する', async () => {
    const store = new FirestoreMetadataStore(new FakeFirestore());
    stores.push(store);
    await store.createProject('demo', 'owner');
    await store.putMemoryIndex('demo', record());
    const tombstone: TombstoneRecord = {
      project_id: 'demo',
      memory_id: 'memory-1',
      content_key: 'projects/demo/memories/note/hash.md',
      deleted_at: '2026-09-19T00:00:01.000Z',
    };

    await store.deleteMemoryIndex('demo', 'memory-1', tombstone);
    expect(await store.getMemoryIndex('demo', 'memory-1')).toBeNull();
    expect(await store.getNameIndex('demo', 'note')).toBeNull();
    expect(await store.isTombstoned('demo', tombstone.content_key)).toBe(true);
  });

  test('不正なmetadata型をFirestoreDataErrorとして拒否する', async () => {
    const gateway = new FakeFirestore();
    const store = new FirestoreMetadataStore(gateway);
    await gateway.set('projects/demo', {
      project_id: 'demo',
      owner_user_id: 'owner',
      created_at: '2026-09-19T00:00:00.000Z',
      updated_at: '2026-09-19T00:00:00.000Z',
      revision: 'not-a-number',
    });
    await expect(store.getProject('demo')).rejects.toBeInstanceOf(FirestoreDataError);
  });

  test('Firebase UIDをFirestore member document IDとして安全にencodeする', async () => {
    const gateway = new FakeFirestore();
    const store = new FirestoreMetadataStore(gateway);
    await store.createProject('demo', 'uid/with/slash');

    expect([...gateway.documents.keys()]).toContain('projects/demo/members/uid%2Fwith%2Fslash');
    await expect(store.getMembership('demo', 'uid/with/slash')).resolves.toMatchObject({
      project_id: 'demo',
      user_id: 'uid/with/slash',
      role: 'owner',
    });
  });
});
