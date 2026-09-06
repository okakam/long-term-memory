import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  BlobMarkdownStore,
  type BlobClient,
  memoryObjectKey,
  memoryPrefix,
} from '@/lib/storage/blob-markdown';
import { createMarkdownStore } from '@/lib/storage/factory';

const originalDriver = process.env.LTM_STORAGE_DRIVER;
const originalHome = process.env.LTM_HOME;
const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
const originalBlobPrefix = process.env.LTM_BLOB_PREFIX;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDriver === undefined) delete process.env.LTM_STORAGE_DRIVER;
  else process.env.LTM_STORAGE_DRIVER = originalDriver;
  if (originalHome === undefined) delete process.env.LTM_HOME;
  else process.env.LTM_HOME = originalHome;
  if (originalToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = originalToken;
  if (originalBlobPrefix === undefined) delete process.env.LTM_BLOB_PREFIX;
  else process.env.LTM_BLOB_PREFIX = originalBlobPrefix;
});

function stream(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

function createFakeClient(): BlobClient & { calls: Array<{ method: string; key?: string; options?: object }> } {
  const objects = new Map<string, { text: string; updatedAt: Date }>();
  const calls: Array<{ method: string; key?: string; options?: object }> = [];
  return {
    calls,
    async put(key, text, options) {
      calls.push({ method: 'put', key, options });
      const updatedAt = new Date('2026-09-05T00:00:00.000Z');
      objects.set(key, { text, updatedAt });
      return { pathname: key };
    },
    async get(key, options) {
      calls.push({ method: 'get', key, options });
      const object = objects.get(key);
      return object ? { statusCode: 200, stream: stream(object.text) } : null;
    },
    async list(options) {
      calls.push({ method: 'list', options });
      const blobs = [...objects.entries()]
        .filter(([key]) => key.startsWith(options.prefix ?? ''))
        .map(([pathname, object]) => ({
          pathname,
          size: Buffer.byteLength(object.text),
          uploadedAt: object.updatedAt,
        }));
      return { blobs, hasMore: false };
    },
    async del(key, options) {
      calls.push({ method: 'del', key, options });
      objects.delete(key);
    },
  };
}

describe('Blob key helpers', () => {
  test('LTM_BLOB_PREFIX で環境ごとのBlob key prefixを切り替える', () => {
    process.env.LTM_BLOB_PREFIX = 'preview';
    expect(memoryPrefix('my-project')).toBe('preview/my-project/memories/');
    expect(memoryObjectKey('my-project', 'memory-name', 'a'.repeat(64))).toContain('preview/my-project/memories/');
  });

  test('content hash 付き immutable key と列挙 prefix を決定的に生成する', () => {
    const hash = 'a'.repeat(64);
    expect(memoryObjectKey('my-project', 'memory-name', hash)).toBe(`projects/my-project/memories/memory-name/${hash}.md`);
    expect(memoryPrefix('my-project')).toBe('projects/my-project/memories/');
    expect(memoryPrefix('my-project', 'memory-name')).toBe('projects/my-project/memories/memory-name/');
    expect(memoryObjectKey('my-project', 'memory-name', hash)).toBe(memoryObjectKey('my-project', 'memory-name', hash));
  });

  test('project/name/hash のパス逸脱入力を拒否する', () => {
    expect(() => memoryObjectKey('../escape', 'memory-name', 'a'.repeat(64))).toThrow();
    expect(() => memoryObjectKey('my-project', '../escape', 'a'.repeat(64))).toThrow();
    expect(() => memoryObjectKey('my-project', 'memory-name', '../escape')).toThrow();
    expect(() => memoryPrefix('my-project', '..')).toThrow();
  });
});

describe('BlobMarkdownStore', () => {
  test('private Blob の write/read/list/remove 契約を満たす', async () => {
    const client = createFakeClient();
    const store = new BlobMarkdownStore(client, () => 'test-token');
    const key = memoryObjectKey('my-project', 'memory-name', 'a'.repeat(64));
    const text = '本文𠮷\n';

    const stored = await store.write(key, text);
    expect(stored).toMatchObject({ key, size: Buffer.byteLength(text) });
    expect(await store.read(key)).toBe(text);
    expect(await store.list(memoryPrefix('my-project'))).toEqual([
      { key, size: Buffer.byteLength(text), updatedAt: new Date('2026-09-05T00:00:00.000Z') },
    ]);
    await store.remove(key);
    await expect(store.read(key)).rejects.toThrow(/not found/i);

    expect(client.calls[0]).toEqual({
      method: 'put',
      key,
      options: {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: 'text/markdown; charset=utf-8',
        token: 'test-token',
      },
    });
    expect(client.calls.find((call) => call.method === 'get')?.options).toMatchObject({ access: 'private', token: 'test-token' });
  });

  test('token を操作時まで検証せず import・生成時に本番 env を要求しない', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const store = new BlobMarkdownStore(createFakeClient());
    await expect(store.read('projects/my-project/memories/name/hash.md')).rejects.toThrow('BLOB_READ_WRITE_TOKEN is required');
  });

  test('vercel factory は LTM_HOME に依存しない', () => {
    process.env.LTM_STORAGE_DRIVER = 'vercel';
    process.env.LTM_HOME = '../unsafe-local-home';
    const client = createFakeClient();
    expect(createMarkdownStore({ blobClient: client, blobToken: 'test-token' })).toBeInstanceOf(BlobMarkdownStore);
  });
});
