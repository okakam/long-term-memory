import { afterEach, describe, expect, test } from 'vitest';

import {
  GcsMarkdownStore,
  memoryObjectKey,
  memoryPrefix,
} from '@/lib/storage/gcs-markdown';
import { createMarkdownStore } from '@/lib/storage/factory';

interface GcsFileOptions {
  contentType?: string;
  resumable?: boolean;
  metadata?: Record<string, string>;
  preconditionOpts?: { ifGenerationMatch?: number | string };
}

interface GcsFileMetadata {
  size?: string | number;
  updated?: string;
  etag?: string;
  metadata?: Record<string, string>;
}

interface FakeObject {
  body: string;
  updatedAt: Date;
  etag: string;
  hash?: string;
}

class FakeGcsFile {
  constructor(
    private readonly storage: FakeGcsStorage,
    public readonly name: string,
  ) {}

  async save(data: string | Uint8Array, options: GcsFileOptions = {}): Promise<void> {
    if (options.preconditionOpts?.ifGenerationMatch === 0 && this.storage.objects.has(this.name)) {
      throw Object.assign(new Error('precondition failed'), { code: 412 });
    }
    const body = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.storage.saveCalls.push({ name: this.name, data: body, options });
    this.storage.objects.set(this.name, {
      body,
      updatedAt: new Date('2026-09-19T00:00:00.000Z'),
      etag: 'etag',
      hash: options.metadata?.['content-sha256'],
    });
  }

  async download(): Promise<[Buffer]> {
    const object = this.storage.objects.get(this.name);
    if (!object) throw Object.assign(new Error('missing'), { code: 404 });
    return [Buffer.from(object.body)];
  }

  async getMetadata(): Promise<[GcsFileMetadata]> {
    const object = this.storage.objects.get(this.name);
    if (!object) throw Object.assign(new Error('missing'), { code: 404 });
    return [{
      size: String(Buffer.byteLength(object.body)),
      updated: object.updatedAt.toISOString(),
      etag: object.etag,
      metadata: object.hash ? { 'content-sha256': object.hash } : undefined,
    }];
  }

  async delete(): Promise<void> {
    if (!this.storage.objects.has(this.name)) {
      throw Object.assign(new Error('missing'), { code: 404 });
    }
    this.storage.objects.delete(this.name);
  }
}

class FakeGcsBucket {
  constructor(private readonly storage: FakeGcsStorage) {}

  file(name: string): FakeGcsFile {
    return new FakeGcsFile(this.storage, name);
  }

  async getFiles(options: { prefix?: string; pageToken?: string } = {}): Promise<[FakeGcsFile[], { pageToken?: string }, unknown]> {
    const prefix = options.prefix ?? '';
    const keys = [...this.storage.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = options.pageToken === 'next' ? 1 : 0;
    const keysForPage = keys.slice(start, start + 1);
    return [
      keysForPage.map((key) => this.file(key)),
      start === 0 && keys.length > 1 ? { pageToken: 'next' } : {},
      undefined,
    ];
  }
}

class FakeGcsStorage {
  readonly objects = new Map<string, FakeObject>();
  readonly saveCalls: Array<{ name: string; data: string; options: GcsFileOptions }> = [];
  private readonly bucketInstance = new FakeGcsBucket(this);

  bucket(): FakeGcsBucket {
    return this.bucketInstance;
  }
}

const storages: FakeGcsStorage[] = [];

afterEach(() => {
  storages.splice(0);
});

describe('GCS key helpers', () => {
  test('prefix、project、name、hashから決定的なkeyを作る', () => {
    const hash = 'a'.repeat(64);
    expect(memoryPrefix('projects', 'demo')).toBe('projects/demo/memories/');
    expect(memoryObjectKey('projects', 'demo', 'note', hash)).toBe(
      `projects/demo/memories/note/${hash}.md`,
    );
  });

  test('unsafe keyとhash以外のproject scopeを拒否する', async () => {
    const storage = new FakeGcsStorage();
    storages.push(storage);
    const store = new GcsMarkdownStore({ storage, bucket: 'bucket', prefix: 'projects', projectId: 'demo' });
    await expect(store.read('../secret')).rejects.toThrow('unsafe');
    await expect(store.read('projects/other/memories/note/hash.md')).rejects.toThrow('scope');
    expect(() => memoryObjectKey('projects', 'demo', 'note', '../hash')).toThrow('invalid content hash');
  });
});

describe('GcsMarkdownStore', () => {
  test('factoryはcloud modeでGCS adapterを選択する', () => {
    const storage = new FakeGcsStorage();
    storages.push(storage);
    expect(createMarkdownStore({
      mode: 'cloud',
      gcsStorage: storage,
      gcsBucket: 'bucket',
      gcsPrefix: 'projects',
      projectId: 'demo',
    })).toBeInstanceOf(GcsMarkdownStore);
  });

  test('immutable write、read、head、list、removeを実装する', async () => {
    const storage = new FakeGcsStorage();
    storages.push(storage);
    const store = new GcsMarkdownStore({ storage, bucket: 'bucket', prefix: 'projects', projectId: 'demo' });
    const hash = 'a'.repeat(64);
    const key = memoryObjectKey('projects', 'demo', 'note', hash);
    const text = '本文𠮷\n';

    const written = await store.write(key, text, { overwrite: false, contentHash: hash });
    expect(written).toMatchObject({ key, size: Buffer.byteLength(text), sha256: hash, etag: 'etag' });
    expect(storage.saveCalls[0]).toMatchObject({
      name: key,
      data: text,
      options: {
        contentType: 'text/markdown; charset=utf-8',
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { 'content-sha256': hash },
      },
    });
    expect(await store.read(key)).toBe(text);
    expect(await store.head(key)).toMatchObject({ key, size: Buffer.byteLength(text), sha256: hash });

    const secondKey = memoryObjectKey('projects', 'demo', 'other', 'b'.repeat(64));
    await store.write(secondKey, '二つ目', { contentHash: 'b'.repeat(64) });
    expect(await store.list(memoryPrefix('projects', 'demo'))).toHaveLength(2);
    await expect(store.write(key, '上書き', { overwrite: false })).rejects.toThrow('precondition');
    await store.remove(key);
    await expect(store.read(key)).rejects.toThrow('not found');
  });
});
