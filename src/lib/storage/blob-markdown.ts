import { del as vercelDel, get as vercelGet, list as vercelList, put as vercelPut } from '@vercel/blob';

import { assertMemoryName, assertProjectId } from '@/lib/slug';
import type { MarkdownStore, StoredObject } from '@/lib/storage/contracts';

interface BlobPutOptions {
  access: 'private';
  addRandomSuffix: false;
  allowOverwrite: boolean;
  contentType: string;
  token: string;
}

interface BlobReadOptions {
  access: 'private';
  token: string;
}

interface BlobListOptions {
  prefix?: string;
  cursor?: string;
  token: string;
}

interface BlobDeleteOptions {
  token: string;
}

export interface BlobClient {
  put(key: string, text: string, options: BlobPutOptions): Promise<{ pathname: string }>;
  get(key: string, options: BlobReadOptions): Promise<{ statusCode: number; stream: ReadableStream<Uint8Array> | null } | null>;
  list(options: BlobListOptions): Promise<{
    blobs: Array<{ pathname: string; size: number; uploadedAt: Date }>;
    cursor?: string;
    hasMore: boolean;
  }>;
  del(key: string, options: BlobDeleteOptions): Promise<void>;
}

const defaultBlobClient: BlobClient = {
  put: (key, text, options) => vercelPut(key, text, options),
  get: (key, options) => vercelGet(key, options),
  list: (options) => vercelList(options),
  del: (key, options) => vercelDel(key, options),
};

function envToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required');
  return token;
}

function validateBlobPath(value: string, allowEmpty = false): void {
  if ((!allowEmpty && value.length === 0) || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`unsafe blob key: ${value}`);
  }
  if (value.split('/').filter(Boolean).some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`unsafe blob key: ${value}`);
  }
}

function blobPrefix(): string {
  const prefix = (process.env.LTM_BLOB_PREFIX ?? 'projects').replace(/^\/+|\/+$/g, '');
  validateBlobPath(prefix);
  return prefix;
}

export function memoryPrefix(projectId: string, name?: string): string {
  const project = assertProjectId(projectId);
  const prefix = blobPrefix();
  if (name === undefined) return `${prefix}/${project}/memories/`;
  return `${prefix}/${project}/memories/${assertMemoryName(name)}/`;
}

export function memoryObjectKey(projectId: string, name: string, contentHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error(`invalid content hash: ${contentHash}`);
  return `${memoryPrefix(projectId, name)}${contentHash}.md`;
}

export class BlobMarkdownStore implements MarkdownStore {
  constructor(
    private readonly client: BlobClient = defaultBlobClient,
    private readonly tokenProvider: () => string = envToken,
  ) {}

  async read(key: string): Promise<string> {
    validateBlobPath(key);
    const result = await this.client.get(key, { access: 'private', token: this.tokenProvider() });
    if (!result || result.statusCode !== 200 || !result.stream) throw new Error(`blob not found: ${key}`);
    return new Response(result.stream).text();
  }

  async write(key: string, text: string, opts?: { overwrite?: boolean }): Promise<StoredObject> {
    validateBlobPath(key);
    const result = await this.client.put(key, text, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: opts?.overwrite ?? false,
      contentType: 'text/markdown; charset=utf-8',
      token: this.tokenProvider(),
    });
    return { key: result.pathname, size: Buffer.byteLength(text), updatedAt: new Date() };
  }

  async remove(key: string): Promise<void> {
    validateBlobPath(key);
    await this.client.del(key, { token: this.tokenProvider() });
  }

  async list(prefix: string): Promise<StoredObject[]> {
    validateBlobPath(prefix, true);
    const token = this.tokenProvider();
    const objects: StoredObject[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.client.list({ prefix, cursor, token });
      objects.push(...result.blobs.map((blob) => ({
        key: blob.pathname,
        size: blob.size,
        updatedAt: blob.uploadedAt,
      })));
      cursor = result.hasMore ? result.cursor : undefined;
      if (result.hasMore && !cursor) throw new Error('Blob list returned hasMore without a cursor');
    } while (cursor);
    return objects.sort((left, right) => left.key.localeCompare(right.key));
  }
}

export function createBlobMarkdownStore(client?: BlobClient, tokenProvider?: () => string): BlobMarkdownStore {
  return new BlobMarkdownStore(client, tokenProvider);
}
