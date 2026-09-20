import { Storage } from '@google-cloud/storage';

import { assertMemoryName, assertProjectId } from '@/lib/slug';
import type { MarkdownStore, MarkdownWriteOptions, StoredObject } from '@/lib/storage/contracts';

export interface GcsPreconditionOptions {
  ifGenerationMatch?: number | string;
}

export interface GcsFileOptions {
  contentType?: string;
  resumable?: boolean;
  metadata?: Record<string, string>;
  preconditionOpts?: GcsPreconditionOptions;
}

export interface GcsObjectMetadata {
  size?: string | number;
  updated?: string;
  etag?: string;
  metadata?: Record<string, string>;
}

export interface GcsFileLike {
  name: string;
  save(data: string | Uint8Array, options?: GcsFileOptions): Promise<void>;
  download(): Promise<[Buffer]>;
  getMetadata(): Promise<[GcsObjectMetadata]>;
  delete(options?: { preconditionOpts?: GcsPreconditionOptions }): Promise<unknown>;
}

export interface GcsListOptions {
  prefix?: string;
  pageToken?: string;
  autoPaginate?: boolean;
}

export interface GcsBucketLike {
  file(name: string): GcsFileLike;
  getFiles(options?: GcsListOptions): Promise<[GcsFileLike[], { pageToken?: string }, unknown]>;
}

export interface GcsStorageLike {
  bucket(name: string): GcsBucketLike;
}

export interface GcsMarkdownStoreOptions {
  storage?: GcsStorageLike;
  bucket?: string;
  prefix?: string;
  projectId?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateRelativePath(value: string, allowEmpty = false): void {
  if ((!allowEmpty && value.length === 0) || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`unsafe GCS key: ${value}`);
  }
  if (value.split('/').filter(Boolean).some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`unsafe GCS key: ${value}`);
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
  return error.name === 'NotFound'
    || error.code === 404
    || error.statusCode === 404
    || (isRecord(metadata) && metadata.httpStatusCode === 404);
}

function notFound(key: string): Error {
  return new Error(`gcs object not found: ${key}`);
}

function dateFromMetadata(value: unknown): Date {
  if (typeof value !== 'string') return new Date(0);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function sizeFromMetadata(value: unknown): number {
  const size = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(size) && size >= 0 ? size : 0;
}

function objectFromMetadata(key: string, result: GcsObjectMetadata): StoredObject {
  return {
    key,
    size: sizeFromMetadata(result.size),
    updatedAt: dateFromMetadata(result.updated),
    etag: result.etag,
    sha256: result.metadata?.['content-sha256'],
  };
}

export function gcsStoragePrefix(): string {
  return normalizePrefix(process.env.LTM_GCS_PREFIX ?? 'projects');
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

export class GcsMarkdownStore implements MarkdownStore {
  private readonly bucket: GcsBucketLike;
  private readonly prefix: string;
  private readonly projectId?: string;

  constructor(options: GcsMarkdownStoreOptions = {}) {
    const bucketName = options.bucket ?? requiredEnv('LTM_GCS_BUCKET');
    this.prefix = normalizePrefix(options.prefix ?? gcsStoragePrefix());
    this.projectId = options.projectId === undefined ? undefined : assertProjectId(options.projectId);
    const storage = options.storage ?? (new Storage() as unknown as GcsStorageLike);
    this.bucket = storage.bucket(bucketName);
  }

  private assertKey(key: string, allowEmpty = false): string {
    validateRelativePath(key, allowEmpty);
    const prefix = this.projectId ? `${this.prefix}/${this.projectId}/` : `${this.prefix}/`;
    if (!key.startsWith(prefix)) throw new Error(`GCS key is outside configured scope: ${key}`);
    return key;
  }

  private file(key: string): GcsFileLike {
    return this.bucket.file(key);
  }

  private async withNotFound<T>(key: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isNotFound(error)) throw notFound(key);
      throw error;
    }
  }

  async read(key: string): Promise<string> {
    const safeKey = this.assertKey(key);
    const [body] = await this.withNotFound(safeKey, () => this.file(safeKey).download());
    return body.toString('utf8');
  }

  async write(key: string, text: string, options: MarkdownWriteOptions = {}): Promise<StoredObject> {
    const safeKey = this.assertKey(key);
    const preconditionOpts = options.overwrite ?? false
      ? undefined
      : { ifGenerationMatch: options.ifMatch ?? 0 };
    const file = this.file(safeKey);
    await file.save(text, {
      resumable: false,
      contentType: 'text/markdown; charset=utf-8',
      metadata: options.contentHash ? { 'content-sha256': options.contentHash } : undefined,
      preconditionOpts,
    });
    const [metadata] = await file.getMetadata();
    const object = objectFromMetadata(safeKey, metadata);
    return {
      ...object,
      size: Buffer.byteLength(text),
      updatedAt: object.updatedAt.getTime() === 0 ? new Date() : object.updatedAt,
      sha256: options.contentHash ?? object.sha256,
    };
  }

  async head(key: string): Promise<StoredObject> {
    const safeKey = this.assertKey(key);
    return this.withNotFound(safeKey, async () => {
      const [metadata] = await this.file(safeKey).getMetadata();
      return objectFromMetadata(safeKey, metadata);
    });
  }

  async remove(key: string): Promise<void> {
    const safeKey = this.assertKey(key);
    await this.withNotFound(safeKey, () => this.file(safeKey).delete());
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const requestedPrefix = prefix.length === 0 ? `${this.prefix}/` : this.assertKey(prefix, true);
    const objects: StoredObject[] = [];
    let pageToken: string | undefined;
    do {
      const [files, nextQuery] = await this.withNotFound(requestedPrefix, () => this.bucket.getFiles({
        prefix: requestedPrefix,
        pageToken,
        autoPaginate: false,
      }));
      for (const file of files) {
        const safeKey = this.assertKey(file.name);
        const [metadata] = await this.withNotFound(safeKey, () => file.getMetadata());
        objects.push(objectFromMetadata(safeKey, metadata));
      }
      pageToken = isRecord(nextQuery) && typeof nextQuery.pageToken === 'string' && nextQuery.pageToken.length > 0
        ? nextQuery.pageToken
        : undefined;
    } while (pageToken);
    return objects.sort((left, right) => left.key.localeCompare(right.key));
  }
}

export function createGcsMarkdownStore(options: GcsMarkdownStoreOptions = {}): GcsMarkdownStore {
  return new GcsMarkdownStore(options);
}
