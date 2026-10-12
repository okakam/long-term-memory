import { expect, test } from 'vitest';

import { LocalCurationStore } from '@/lib/curation/local-store';
import { parseCurationWindow } from '@/lib/curation/window';

test('incomplete_run_cannot_advance_cursor', async () => {
  const store = new LocalCurationStore(':memory:');
  try {
    const window = parseCurationWindow({ mode: 'schedule', dry_run: false }, '2026-10-12T00:00:00.000Z');
    const run = await store.begin('alpha', window, '2026-10-12T00:00:00.000Z');
    await store.savePage(run.run_id, {
      page_index: 0,
      after: null,
      next_after: null,
      snapshot_complete: true,
      items: [{ memory_id: 'memory-1', content_hash: 'a'.repeat(64) }],
    });
    await expect(store.complete(run.run_id)).resolves.toMatchObject({ advanced: false });
    await expect(store.getCursor('alpha')).resolves.toBeNull();

    await store.recordOutcomes(run.run_id, 0, [{ source_memory_id: 'memory-1', outcome: 'skipped', reason_code: 'not_generalizable' }]);
    await expect(store.complete(run.run_id)).resolves.toMatchObject({ advanced: true });
    await expect(store.getCursor('alpha')).resolves.toBe('2026-10-12T00:00:00.000Z');
  } finally {
    store.close();
  }
});
