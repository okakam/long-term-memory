export type StorageMode = 'local' | 'vercel';
export interface StoredObject {
  key: string;
  size: number;
  updatedAt: Date;
}
export interface MarkdownStore {
  read(key: string): Promise<string>;
  write(key: string, text: string, opts?: { overwrite?: boolean }): Promise<StoredObject>;
  remove(key: string): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
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
  if (mode === 'local' || mode === 'vercel') return mode;
  throw new Error('LTM_STORAGE_DRIVER must be local or vercel');
}
