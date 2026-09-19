import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { assertMemoryName, assertProjectId } from '@/lib/slug';
import type { MarkdownStore, MarkdownWriteOptions, StoredObject } from '@/lib/storage/contracts';

export interface S3ClientLike {
  send(command: { input: object }): Promise<unknown>;
}

export interface S3MarkdownStoreOptions {
  client?: S3ClientLike;
  bucket?: string;
  prefix?: string;
  projectId?: string;
  region?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateRelativePath(value: string, allowEmpty = false): void {
  if ((!allowEmpty && value.length === 0) || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`unsafe S3 key: ${value}`);
  }
  if (value.split('/').filter(Boolean).some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`unsafe S3 key: ${value}`);
  }
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, '');
  validateRelativePath(normalized);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNotFound(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const metadata = error.$metadata;
  return error.name === 'NoSuchKey'
    || error.name === 'NotFound'
    || (isRecord(metadata) && metadata.httpStatusCode === 404);
}

function notFound(key: string): Error {
  return new Error(`s3 object not found: ${key}`);
}

async function bodyToText(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (isRecord(body) && typeof body.transformToString === 'function') {
    return String(await (body.transformToString as () => Promise<string>)());
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return new Response(body).text();
  }
  if (isRecord(body) && Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    }
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(result);
  }
  throw new Error('S3 object response did not contain a readable body');
}

function objectFromHead(key: string, result: Record<string, unknown>): StoredObject {
  return {
    key,
    size: typeof result.ContentLength === 'number' ? result.ContentLength : 0,
    updatedAt: result.LastModified instanceof Date ? result.LastModified : new Date(0),
    etag: typeof result.ETag === 'string' ? result.ETag : undefined,
    sha256: isRecord(result.Metadata) && typeof result.Metadata['content-sha256'] === 'string'
      ? result.Metadata['content-sha256']
      : undefined,
  };
}

export function s3StoragePrefix(): string {
  return normalizePrefix(process.env.LTM_S3_PREFIX ?? 'projects');
}

export function memoryPrefix(prefix: string, projectId: string, name?: string): string {
  const project = assertProjectId(projectId);
  const base = `${normalizePrefix(prefix)}/${project}/memories/`;
  return name === undefined ? base : `${base}${assertMemoryName(name)}/`;
}

export function memoryObjectKey(prefix: string, projectId: string, name: string, contentHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error(`invalid content hash: ${contentHash}`);
  return `${memoryPrefix(prefix, projectId, name)}${contentHash}.md`;
}

export class S3MarkdownStore implements MarkdownStore {
  private readonly client: S3ClientLike;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly projectId?: string;

  constructor(options: S3MarkdownStoreOptions = {}) {
    this.bucket = options.bucket ?? requiredEnv('LTM_S3_BUCKET');
    this.prefix = normalizePrefix(options.prefix ?? s3StoragePrefix());
    this.projectId = options.projectId === undefined ? undefined : assertProjectId(options.projectId);
    this.client = options.client ?? (new S3Client({ region: options.region ?? process.env.AWS_REGION }) as unknown as S3ClientLike);
  }

  private assertKey(key: string, allowEmpty = false): string {
    validateRelativePath(key, allowEmpty);
    const prefix = this.projectId ? `${this.prefix}/${this.projectId}/` : `${this.prefix}/`;
    if (!key.startsWith(prefix)) throw new Error(`S3 key is outside configured scope: ${key}`);
    return key;
  }

  private async send(command: { input: object }, key: string): Promise<Record<string, unknown>> {
    try {
      return (await this.client.send(command)) as Record<string, unknown>;
    } catch (error) {
      if (isNotFound(error)) throw notFound(key);
      throw error;
    }
  }

  async read(key: string): Promise<string> {
    const safeKey = this.assertKey(key);
    const result = await this.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey }), safeKey);
    return bodyToText(result.Body);
  }

  async write(key: string, text: string, options: MarkdownWriteOptions = {}): Promise<StoredObject> {
    const safeKey = this.assertKey(key);
    const result = await this.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: safeKey,
      Body: text,
      ContentType: 'text/markdown; charset=utf-8',
      Metadata: options.contentHash ? { 'content-sha256': options.contentHash } : undefined,
      IfNoneMatch: options.overwrite ?? false ? undefined : '*',
      IfMatch: options.ifMatch,
    }), safeKey);
    return {
      key: safeKey,
      size: Buffer.byteLength(text),
      updatedAt: new Date(),
      etag: typeof result.ETag === 'string' ? result.ETag : undefined,
      sha256: options.contentHash,
    };
  }

  async head(key: string): Promise<StoredObject> {
    const safeKey = this.assertKey(key);
    return objectFromHead(safeKey, await this.send(new HeadObjectCommand({ Bucket: this.bucket, Key: safeKey }), safeKey));
  }

  async remove(key: string): Promise<void> {
    const safeKey = this.assertKey(key);
    await this.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey }), safeKey);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const requestedPrefix = prefix.length === 0 ? `${this.prefix}/` : this.assertKey(prefix, true);
    const objects: StoredObject[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: requestedPrefix,
        ContinuationToken: continuationToken,
      }), requestedPrefix);
      const contents = Array.isArray(result.Contents) ? result.Contents : [];
      for (const item of contents) {
        if (!isRecord(item) || typeof item.Key !== 'string') continue;
        objects.push({
          key: item.Key,
          size: typeof item.Size === 'number' ? item.Size : 0,
          updatedAt: item.LastModified instanceof Date ? item.LastModified : new Date(0),
          etag: typeof item.ETag === 'string' ? item.ETag : undefined,
        });
      }
      if (result.IsTruncated) {
        if (typeof result.NextContinuationToken !== 'string' || result.NextContinuationToken.length === 0) {
          throw new Error('S3 list returned IsTruncated without a continuation token');
        }
        continuationToken = result.NextContinuationToken;
      } else {
        continuationToken = undefined;
      }
    } while (continuationToken);
    return objects.sort((left, right) => left.key.localeCompare(right.key));
  }
}

export function createS3MarkdownStore(options: S3MarkdownStoreOptions = {}): S3MarkdownStore {
  return new S3MarkdownStore(options);
}
