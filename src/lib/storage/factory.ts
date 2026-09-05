import { BlobMarkdownStore, type BlobClient } from '@/lib/storage/blob-markdown';
import type { MarkdownStore, StorageMode } from '@/lib/storage/contracts';
import { resolveStorageMode } from '@/lib/storage/contracts';
import { FsMarkdownStore } from '@/lib/storage/fs-markdown';

export interface MarkdownStoreOptions {
  mode?: StorageMode;
  localRoot?: string;
  blobClient?: BlobClient;
  blobToken?: string;
}

export function createMarkdownStore(options: MarkdownStoreOptions = {}): MarkdownStore {
  const mode = options.mode ?? resolveStorageMode();
  if (mode === 'local') return new FsMarkdownStore(options.localRoot);
  return new BlobMarkdownStore(
    options.blobClient,
    options.blobToken === undefined ? undefined : () => options.blobToken as string,
  );
}
