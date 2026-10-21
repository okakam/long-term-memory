import { afterEach, describe, expect, test } from 'vitest';

import type {
  FirestoreDocument,
  FirestoreGateway,
  FirestoreTransaction,
  MemoryIndexRecord,
} from '@/lib/storage/firestore-metadata';
import { FirestoreCurationStore } from '@/lib/curation/firestore-store';
import {
  AdminFirestoreGateway,
  FirestoreDataError,
  FirestoreMetadataStore,
  withoutUndefined,
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
  test('shared restore requests persist only audit metadata and complete once', async () => {
    const gateway = new FakeFirestore();
    const store = new FirestoreCurationStore(gateway);
    const request = await store.createRestoreRequest({
      memory_id: 'memory-1', revision_id: 'revision-1', expected_hash: 'a'.repeat(64),
      requested_by: 'curator-uid', requested_at: '2026-10-12T00:00:00.000Z',
    });
    expect([...gateway.documents.keys()].some((path) => path.startsWith('projects/__shared__/sharedRestoreRequests/'))).toBe(true);
    await expect(store.listRestoreRequests()).resolves.toEqual([request]);
    await expect(store.completeRestoreRequest(request.id, {
      state: 'succeeded', completed_at: '2026-10-12T01:00:00.000Z',
    })).resolves.toMatchObject({ state: 'succeeded' });
    await expect(store.completeRestoreRequest(request.id, {
      state: 'failed', completed_at: '2026-10-12T02:00:00.000Z', failure_reason: 'restore_conflict',
    })).resolves.toMatchObject({ state: 'succeeded', completed_at: '2026-10-12T01:00:00.000Z' });
  });

  test('pages_all_records_with_same_timestamp', async () => {
    const store = new FirestoreMetadataStore(new FakeFirestore());
    stores.push(store);
    await store.createProject('demo', 'owner');
    for (let index = 0; index < 501; index += 1) {
      const suffix = String(index).padStart(4, '0');
      await store.putMemoryIndex('demo', record({
        id: `memory-${suffix}`,
        name: `memory-${suffix}`,
        content_key: `projects/demo/memories/memory-${suffix}.md`,
        created_at: '2026-09-19T00:00:00.000Z',
      }));
    }
    const all: string[] = [];
    let after: { created_at: string; id: string } | null = null;
    do {
      const page = await store.listMemoryIndexPage('demo', {
        from: '2026-09-19T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z', after, limit: 25,
      });
      all.push(...page.items.map((item) => item.id));
      after = page.next;
    } while (after !== null);
    expect(all).toHaveLength(501);
    expect(new Set(all).size).toBe(501);
    expect(all).toEqual([...all].sort());
  });

  test('save transactionはmemoryとname indexを同時に作成する', async () => {
    const store = new FirestoreMetadataStore(new FakeFirestore());
    stores.push(store);
    await store.createProject('demo', 'owner');
    await store.putMemoryIndex('demo', record());

    expect(await store.getMemoryIndex('demo', 'memory-1')).toEqual({ ...record(), status: 'active' });
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

describe('AdminFirestoreGateway', () => {
  test('optional fieldのundefinedを除いてFirestoreへ書き込む', async () => {
    const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
    const firestore = {
      doc: (path: string) => ({
        set: async (data: Record<string, unknown>) => { writes.push({ path, data }); },
        update: async (data: Record<string, unknown>) => { writes.push({ path, data }); },
      }),
    };
    const gateway = new AdminFirestoreGateway(firestore as never);
    await gateway.set('projects/p/memories/m', {
      name: 'memory', status: 'active', archived_at: undefined, archived_by: undefined, tags: ['a'],
    });
    await gateway.update('projects/p/members/u', { role: 'member', note: undefined });
    expect(writes).toStrictEqual([
      { path: 'projects/p/memories/m', data: { name: 'memory', status: 'active', tags: ['a'] } },
      { path: 'projects/p/members/u', data: { role: 'member' } },
    ]);
  });

  test('withoutUndefinedはnested plain objectも処理しclass instanceと配列は保つ', () => {
    const date = new Date('2026-10-21T00:00:00.000Z');
    expect(withoutUndefined({ event: { reason: undefined, at: date }, ids: ['x'], empty: null })).toStrictEqual({
      event: { at: date }, ids: ['x'], empty: null,
    });
  });
});
