import type { MarkdownStore, StorageMode } from '@/lib/storage/contracts';
import { resolveStorageMode } from '@/lib/storage/contracts';
import { FsMarkdownStore } from '@/lib/storage/fs-markdown';
import { GcsMarkdownStore, type GcsStorageLike } from '@/lib/storage/gcs-markdown';

export interface MarkdownStoreOptions {
  mode?: StorageMode;
  localRoot?: string;
  gcsStorage?: GcsStorageLike;
  gcsBucket?: string;
  gcsPrefix?: string;
  projectId?: string;
}

export function createMarkdownStore(options: MarkdownStoreOptions = {}): MarkdownStore {
  const mode = options.mode ?? resolveStorageMode();
  if (mode === 'local') return new FsMarkdownStore(options.localRoot);
  return new GcsMarkdownStore({
    storage: options.gcsStorage,
    bucket: options.gcsBucket,
    prefix: options.gcsPrefix,
    projectId: options.projectId,
  });
}
