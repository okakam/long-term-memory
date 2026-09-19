export type StorageMode = 'local' | 'vercel' | 'cloud';
export interface StoredObject {
  key: string;
  size: number;
  updatedAt: Date;
  etag?: string;
  sha256?: string;
}
export interface MarkdownWriteOptions {
  overwrite?: boolean;
  ifMatch?: string;
  contentHash?: string;
}
export interface MarkdownStore {
  read(key: string): Promise<string>;
  write(key: string, text: string, opts?: MarkdownWriteOptions): Promise<StoredObject>;
  remove(key: string): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
  head?(key: string): Promise<StoredObject>;
}
export type SqlValue = string | number | bigint | Uint8Array | null;
export interface IndexStore {
  exec(sql: string, args?: readonly SqlValue[]): Promise<void>;
  query<T extends object>(sql: string, args?: readonly SqlValue[]): Promise<T[]>;
  transaction<T>(fn: (store: IndexStore) => Promise<T>): Promise<T>;
  close?(): void | Promise<void>;
}
export function resolveStorageMode(): StorageMode {
  const mode = process.env.LTM_STORAGE_DRIVER ?? 'local';
  if (mode === 'local' || mode === 'vercel' || mode === 'cloud') return mode;
  throw new Error('LTM_STORAGE_DRIVER must be local, vercel, or cloud');
}
