import type Database from 'better-sqlite3';

import type { MarkdownStore, StoredObject } from '@/lib/storage/contracts';

export interface ReconcileObjectsOptions {
  prefix: string;
  now?: Date;
  graceMs?: number;
  dryRun?: boolean;
}

export interface ReconcileObjectsResult {
  orphaned: StoredObject[];
  deleted: string[];
}

export async function reconcileObjects(
  db: Database.Database,
  store: MarkdownStore,
  options: ReconcileObjectsOptions,
): Promise<ReconcileObjectsResult> {
  const now = options.now ?? new Date();
  const graceMs = Math.max(0, options.graceMs ?? 24 * 60 * 60 * 1000);
  const referenced = new Set((db.prepare(`SELECT file_path AS content_key FROM memories
    UNION SELECT content_key FROM memory_revisions`).all() as Array<{ content_key: string }>).map((row) => row.content_key));
  const objects = await store.list(options.prefix);
  const orphaned = objects
    .filter((object) => object.key.endsWith('.md') && !referenced.has(object.key))
    .filter((object) => now.getTime() - object.updatedAt.getTime() >= graceMs)
    .sort((left, right) => left.key.localeCompare(right.key));
  const deleted: string[] = [];
  if (!options.dryRun) {
    for (const object of orphaned) {
      await store.remove(object.key);
      deleted.push(object.key);
    }
  }
  return { orphaned, deleted };
}
