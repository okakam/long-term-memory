import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openLocalDb } from '@/lib/storage/local-index';
import type { LocalIndexStore } from '@/lib/storage/local-index';

export function openEphemeralIndex(path = join(tmpdir(), 'long-term-memory', 'index.db')): LocalIndexStore {
  return openLocalDb(path);
}
