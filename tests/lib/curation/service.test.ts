import { beforeEach, expect, test, vi } from 'vitest';

import type { Memory } from '@/lib/memory/types';
import type { MemoryServiceLike } from '@/lib/memory/singleton';
import { LocalCurationStore } from '@/lib/curation/local-store';
import { CurationService } from '@/lib/curation/service';
import type { CurationMemoryCursor } from '@/lib/curation/types';

const now = '2026-10-12T00:00:00.000Z';

function memory(id: string, createdAt = '2026-10-01T00:00:00.000Z'): Memory {
  return {
    id, name: id, description: 'Shared knowledge candidate', type: 'session', tags: [], links: [], entities: [], triples: [],
    supersedes: [], body: `Durable fact ${id}`, created_at: createdAt, updated_at: createdAt,
  };
}

function setup(total: number) {
  const curationStore = new LocalCurationStore(':memory:');
  const records = Array.from({ length: total }, (_, index) => ({
    memory: memory(`memory-${String(index).padStart(4, '0')}`),
    content_hash: index.toString(16).padStart(64, '0'),
  }));
  const listCurationMemories = vi.fn(async (
    _projectId: string,
    window: { from: string | null; to: string },
    after: CurationMemoryCursor | null,
    limit: number,
  ) => {
    const filtered = records.filter(({ memory: item }) => Date.parse(item.created_at) < Date.parse(window.to)
      && (window.from === null || Date.parse(item.created_at) >= Date.parse(window.from))
      && (after === null || item.created_at > after.created_at || (item.created_at === after.created_at && item.id > after.id)));
    const selected = filtered.slice(0, limit);
    const last = selected.at(-1)?.memory;
    return {
      items: selected,
      next_after: filtered.length > limit && last ? { created_at: last.created_at, id: last.id } : null,
    };
  });
  const source = {
    curationStore,
    listCurationMemories,
    listMaintenanceMemories: vi.fn(async () => ({ items: [], next_after: null })),
  } as unknown as MemoryServiceLike;
  const service = new CurationService(source, () => now);
  return { service, curationStore, listCurationMemories, records };
}

beforeEach(() => {
  process.env.LTM_MAINTENANCE_TOKEN = 'test-curation-signing-secret';
});

test('shared source snapshot covers all pages and cursor advances only after every outcome', async () => {
  const { service, curationStore, records } = setup(501);
  try {
    const processedIds: string[] = [];
    let page = await service.sourceSnapshot({ project_id: 'alpha', window: { mode: 'schedule', dry_run: false } });
    while (true) {
      processedIds.push(...page.memories.map(({ memory: item }) => item.id));
      await service.recordOutcomes('alpha', page.run_id, page.page_index, page.memories.map(({ memory: item }) => ({
        source_memory_id: item.id, outcome: 'skipped', reason_code: 'not_generalizable',
      })));
      if (!page.next_page) break;
      page = await service.sourceSnapshot({ project_id: 'alpha', after: page.next_page });
    }
    expect(processedIds).toHaveLength(501);
    expect(new Set(processedIds).size).toBe(501);
    await expect(service.complete('alpha', page.run_id)).resolves.toMatchObject({ advanced: true, cursor: now });
    expect(await curationStore.getCursor('alpha')).toBe(now);
    expect(processedIds).toEqual(records.map(({ memory: item }) => item.id));
  } finally {
    curationStore.close();
  }
});

test('manual dry-run pages use signed tokens and do not persist a run or cursor', async () => {
  const { service, curationStore } = setup(30);
  try {
    const first = await service.sourceSnapshot({
      project_id: 'alpha', window: { mode: 'manual', dry_run: true, from_date: '2026-10-01', to_date: '2026-10-02' },
    });
    expect(first.memories).toHaveLength(25);
    expect(first.next_page).toBeTruthy();
    const second = await service.sourceSnapshot({ project_id: 'alpha', after: first.next_page! });
    expect(second.memories).toHaveLength(5);
    expect(second.complete).toBe(true);
    expect(await curationStore.getRun(first.run_id)).toBeNull();
    expect(await curationStore.getCursor('alpha')).toBeNull();
  } finally {
    curationStore.close();
  }
});

test('dry-run without explicit dates starts from the current per-project cursor', async () => {
  const { service, curationStore } = setup(0);
  try {
    const run = await curationStore.begin('alpha', {
      from: null, to: '2026-10-05T00:00:00.000Z', mode: 'schedule', dry_run: false,
    }, '2026-10-05T00:00:00.000Z');
    await curationStore.savePage(run.run_id, {
      page_index: 0, after: null, next_after: null, snapshot_complete: true, items: [],
    });
    await curationStore.recordOutcomes(run.run_id, 0, []);
    await curationStore.complete(run.run_id, '2026-10-05T00:00:00.000Z');

    const page = await service.sourceSnapshot({ project_id: 'alpha', window: { mode: 'manual', dry_run: true } });
    expect(page.window.from).toBe('2026-10-05T00:00:00.000Z');
    expect(await curationStore.getRun(page.run_id)).toBeNull();
    expect(await curationStore.getCursor('alpha')).toBe('2026-10-05T00:00:00.000Z');
  } finally {
    curationStore.close();
  }
});
