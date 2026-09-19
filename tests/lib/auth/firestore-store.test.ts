import { expect, test } from 'vitest';

import { FirestoreAuthStore } from '@/lib/auth/firestore-store';
import { FirestoreMetadataStore, type FirestoreGateway, type FirestoreDocument, type FirestoreTransaction } from '@/lib/storage/firestore-metadata';

class FakeFirestore implements FirestoreGateway {
  readonly documents = new Map<string, Record<string, unknown>>();
  listCalls = 0;

  async get(path: string): Promise<FirestoreDocument> {
    return this.snapshot(path);
  }

  async list(collectionPath: string): Promise<FirestoreDocument[]> {
    this.listCalls += 1;
    const prefix = `${collectionPath}/`;
    return [...this.documents.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map((path) => this.snapshot(path));
  }

  async set(path: string, data: Record<string, unknown>, merge = false): Promise<void> {
    this.documents.set(path, merge && this.documents.has(path) ? { ...this.documents.get(path), ...data } : { ...data });
  }

  async update(path: string, data: Record<string, unknown>): Promise<void> {
    await this.set(path, data, true);
  }

  async delete(path: string): Promise<void> {
    this.documents.delete(path);
  }

  async runTransaction<T>(fn: (transaction: FirestoreTransaction) => Promise<T>): Promise<T> {
    return fn({
      get: (path) => this.get(path),
      set: (path, data, merge) => this.set(path, data, merge),
      update: (path, data) => this.update(path, data),
      delete: (path) => this.delete(path),
    });
  }

  private snapshot(path: string): FirestoreDocument {
    return {
      id: path.split('/').at(-1)!,
      path,
      exists: this.documents.has(path),
      data: () => this.documents.get(path),
    };
  }
}

test('FirestoreAuthStoreはproject membershipとPAT hash-only操作を提供する', async () => {
  const gateway = new FakeFirestore();
  const metadata = new FirestoreMetadataStore(gateway);
  const store = new FirestoreAuthStore(metadata);
  await store.createProject('demo', 'owner');
  await store.addMember('demo', 'member');
  await store.insertToken({
    id: 'token-id',
    user_id: 'owner',
    token_hash: 'hash-only',
    token_prefix: 'ltm_hash',
    label: 'CLI',
    audience: 'mcp',
    created_at: '2026-09-19T00:00:00.000Z',
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
  });

  await expect(store.getMembership('demo', 'member')).resolves.toMatchObject({ role: 'member' });
  await expect(store.listAccessibleProjects('member')).resolves.toHaveLength(1);
  await expect(store.findTokenByHash('hash-only')).resolves.toMatchObject({ token_hash: 'hash-only' });
  await expect(store.listTokens('owner')).resolves.toEqual([expect.objectContaining({ id: 'token-id' })]);
  gateway.listCalls = 0;
  await store.touchToken('token-id', '2026-09-19T00:00:01.000Z', 'hash-only');
  expect(gateway.listCalls).toBe(0);
  expect(gateway.documents.get('mcpTokens/hash-only')?.last_used_at).toBe('2026-09-19T00:00:01.000Z');
});
