import { BlobMarkdownStore, type BlobClient } from '@/lib/storage/blob-markdown';
import type { MarkdownStore, StorageMode } from '@/lib/storage/contracts';
import { resolveStorageMode } from '@/lib/storage/contracts';
import { FsMarkdownStore } from '@/lib/storage/fs-markdown';
import { S3MarkdownStore, type S3ClientLike } from '@/lib/storage/s3-markdown';

export interface MarkdownStoreOptions {
  mode?: StorageMode;
  localRoot?: string;
  blobClient?: BlobClient;
  blobToken?: string;
  s3Client?: S3ClientLike;
  s3Bucket?: string;
  s3Prefix?: string;
  projectId?: string;
  awsRegion?: string;
}

export function createMarkdownStore(options: MarkdownStoreOptions = {}): MarkdownStore {
  const mode = options.mode ?? resolveStorageMode();
  if (mode === 'local') return new FsMarkdownStore(options.localRoot);
  if (mode === 'vercel') {
    return new BlobMarkdownStore(
      options.blobClient,
      options.blobToken === undefined ? undefined : () => options.blobToken as string,
    );
  }
  return new S3MarkdownStore({
    client: options.s3Client,
    bucket: options.s3Bucket,
    prefix: options.s3Prefix,
    projectId: options.projectId,
    region: options.awsRegion,
  });
}
