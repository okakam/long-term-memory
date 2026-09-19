import { del, get, list, put } from '@vercel/blob';

import type { MarkdownStore, StoredObject } from '@/lib/storage/contracts';

interface BlobClient {
  put(key: string, text: string, options: { access: 'private'; addRandomSuffix: false; allowOverwrite: boolean; contentType: string; token: string }): Promise<{ pathname: string }>;
  get(key: string, options: { access: 'private'; token: string }): Promise<{ statusCode: number; stream: ReadableStream<Uint8Array> | null } | null>;
  list(options: { prefix?: string; cursor?: string; token: string }): Promise<{ blobs: Array<{ pathname: string; size: number; uploadedAt: Date }>; cursor?: string; hasMore: boolean }>;
  del(key: string, options: { token: string }): Promise<void>;
}

const client: BlobClient = {
  put: (key, text, options) => put(key, text, options),
  get: (key, options) => get(key, options),
  list: (options) => list(options),
  del: (key, options) => del(key, options),
};

export function createLegacyVercelBlobStore(token: string): MarkdownStore {
  const readOptions = { access: 'private' as const, token };
  return {
    async read(key) {
      const result = await client.get(key, readOptions);
      if (!result || result.statusCode !== 200 || !result.stream) throw new Error(`blob not found: ${key}`);
      return new Response(result.stream).text();
    },
    async write(key, text, options = {}) {
      const result = await client.put(key, text, {
        access: 'private', addRandomSuffix: false, allowOverwrite: options.overwrite ?? false,
        contentType: 'text/markdown; charset=utf-8', token,
      });
      return { key: result.pathname, size: Buffer.byteLength(text), updatedAt: new Date() };
    },
    async remove(key) { await client.del(key, { token }); },
    async list(prefix) {
      const objects: StoredObject[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.list({ prefix, cursor, token });
        objects.push(...page.blobs.map((blob) => ({ key: blob.pathname, size: blob.size, updatedAt: blob.uploadedAt })));
        cursor = page.hasMore ? page.cursor : undefined;
        if (page.hasMore && !cursor) throw new Error('Blob list returned hasMore without a cursor');
      } while (cursor);
      return objects.sort((left, right) => left.key.localeCompare(right.key));
    },
  };
}
