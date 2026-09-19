import { afterEach, describe, expect, test } from 'vitest';

import {
  S3MarkdownStore,
  memoryObjectKey,
  memoryPrefix,
} from '@/lib/storage/s3-markdown';
import { createMarkdownStore } from '@/lib/storage/factory';

interface CommandLike {
  input: Record<string, unknown>;
  constructor: { name: string };
}

class FakeS3Client {
  readonly commands: CommandLike[] = [];
  readonly objects = new Map<string, { body: string; updatedAt: Date; etag: string; hash?: string }>();

  async send(command: CommandLike): Promise<Record<string, unknown>> {
    this.commands.push(command);
    const input = command.input;
    const key = String(input.Key ?? '');
    if (command.constructor.name === 'PutObjectCommand') {
      if (input.IfNoneMatch === '*' && this.objects.has(key)) {
        const error = new Error('precondition failed') as Error & { $metadata?: { httpStatusCode: number } };
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      const body = String(input.Body ?? '');
      this.objects.set(key, {
        body,
        updatedAt: new Date('2026-09-19T00:00:00.000Z'),
        etag: '"etag"',
        hash: (input.Metadata as Record<string, string> | undefined)?.['content-sha256'],
      });
      return { ETag: '"etag"' };
    }
    if (command.constructor.name === 'GetObjectCommand') {
      const object = this.objects.get(key);
      if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      return { Body: new TextEncoder().encode(object.body) };
    }
    if (command.constructor.name === 'HeadObjectCommand') {
      const object = this.objects.get(key);
      if (!object) throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      return {
        ContentLength: Buffer.byteLength(object.body),
        LastModified: object.updatedAt,
        ETag: object.etag,
        Metadata: object.hash ? { 'content-sha256': object.hash } : undefined,
      };
    }
    if (command.constructor.name === 'DeleteObjectCommand') {
      this.objects.delete(key);
      return {};
    }
    if (command.constructor.name === 'ListObjectsV2Command') {
      const keys = [...this.objects.keys()].sort();
      const start = input.ContinuationToken === 'next' ? 1 : 0;
      const contents = keys.slice(start, start + 1).map((item) => {
        const object = this.objects.get(item)!;
        return { Key: item, Size: Buffer.byteLength(object.body), LastModified: object.updatedAt, ETag: object.etag };
      });
      return {
        Contents: contents,
        IsTruncated: start === 0 && keys.length > 1,
        NextContinuationToken: start === 0 && keys.length > 1 ? 'next' : undefined,
      };
    }
    throw new Error(`unexpected command: ${command.constructor.name}`);
  }
}

const clients: FakeS3Client[] = [];

afterEach(() => {
  clients.splice(0);
});

describe('S3 key helpers', () => {
  test('prefix、project、name、hashから決定的なkeyを作る', () => {
    const hash = 'a'.repeat(64);
    expect(memoryPrefix('projects', 'demo')).toBe('projects/demo/memories/');
    expect(memoryObjectKey('projects', 'demo', 'note', hash)).toBe(
      `projects/demo/memories/note/${hash}.md`,
    );
  });

  test('unsafe keyとhash以外のproject scopeを拒否する', async () => {
    const client = new FakeS3Client();
    clients.push(client);
    const store = new S3MarkdownStore({ client, bucket: 'bucket', prefix: 'projects', projectId: 'demo' });
    await expect(store.read('../secret')).rejects.toThrow('unsafe');
    await expect(store.read('projects/other/memories/note/hash.md')).rejects.toThrow('scope');
    expect(() => memoryObjectKey('projects', 'demo', 'note', '../hash')).toThrow('invalid content hash');
  });
});

describe('S3MarkdownStore', () => {
  test('factoryはcloud modeでS3 adapterを選択する', () => {
    const client = new FakeS3Client();
    clients.push(client);
    expect(createMarkdownStore({
      mode: 'cloud',
      s3Client: client,
      s3Bucket: 'bucket',
      s3Prefix: 'projects',
      projectId: 'demo',
    })).toBeInstanceOf(S3MarkdownStore);
  });

  test('immutable write、read、head、list、removeを実装する', async () => {
    const client = new FakeS3Client();
    clients.push(client);
    const store = new S3MarkdownStore({ client, bucket: 'bucket', prefix: 'projects', projectId: 'demo' });
    const hash = 'a'.repeat(64);
    const key = memoryObjectKey('projects', 'demo', 'note', hash);
    const text = '本文𠮷\n';

    const written = await store.write(key, text, { overwrite: false, contentHash: hash });
    expect(written).toMatchObject({ key, size: Buffer.byteLength(text), sha256: hash, etag: '"etag"' });
    expect(client.commands[0]?.input).toMatchObject({
      Bucket: 'bucket',
      Key: key,
      ContentType: 'text/markdown; charset=utf-8',
      IfNoneMatch: '*',
      Metadata: { 'content-sha256': hash },
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
