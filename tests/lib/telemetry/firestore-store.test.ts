import { afterEach, expect, test, vi } from 'vitest';

import { FirestoreTelemetryStore, TELEMETRY_RETENTION_DAYS, type TelemetryEventsBackend } from '@/lib/telemetry/firestore-store';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function memoryBackend() {
  const documents: Record<string, unknown>[] = [];
  const backend: TelemetryEventsBackend = {
    add: async (data) => { documents.push(data); },
    list: async ({ from, to }) => documents.filter((document) => (
      (!from || String(document.ts) >= from.toISOString()) && (!to || String(document.ts) < to.toISOString())
    )),
  };
  return { backend, documents };
}

test('tool callを本文なしの集計fieldとTTL付きで保存し、rowとして読み戻す', async () => {
  const { backend, documents } = memoryBackend();
  const store = new FirestoreTelemetryStore(backend);
  await store.recordToolCall({
    ts: '2026-11-01T00:00:00.000Z', projectId: 'alpha', tool: 'get_memory', kind: 'read',
    ok: true, durationMs: 4.7, resultCount: 1, resultChars: 12,
  });

  expect(documents[0]).toStrictEqual({
    ts: '2026-11-01T00:00:00.000Z', event: 'tool_call', project_id: 'alpha', session_id: null, user_id: null,
    tool: 'get_memory', kind: 'read', ok: 1, error_code: null, duration_ms: 4,
    result_count: 1, result_chars: 12, maintenance: 0,
    expires_at: new Date(Date.parse('2026-11-01T00:00:00.000Z') + TELEMETRY_RETENTION_DAYS * 86_400_000),
  });
  const rows = await store.rows({ projectId: 'alpha' });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: 1, tool: 'get_memory', ok: 1 });
  expect(rows[0]).not.toHaveProperty('expires_at');
  expect(await store.rows({ projectId: 'other' })).toEqual([]);
});

test('connectを保存し、期間で絞り込む', async () => {
  const { backend } = memoryBackend();
  const store = new FirestoreTelemetryStore(backend);
  await store.recordConnect({ ts: '2026-10-01T00:00:00.000Z', projectId: 'alpha', sessionId: 'old' });
  await store.recordConnect({ ts: '2026-11-01T00:00:00.000Z', projectId: 'alpha', sessionId: 'new' });

  const rows = await store.rows({ from: new Date('2026-10-15T00:00:00.000Z') });
  expect(rows.map((row) => row.session_id)).toEqual(['new']);
  expect(rows[0]).toMatchObject({ event: 'connect', tool: null, kind: null, ok: 1 });
});

test('書き込み失敗はMCP呼び出しへ伝えず、次の書き込みも試す', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const add = vi.fn<TelemetryEventsBackend['add']>().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue();
  const store = new FirestoreTelemetryStore({ add, list: async () => [] });
  const event = { projectId: 'alpha', sessionId: 's' };

  await expect(store.recordConnect(event)).resolves.toBeUndefined();
  await expect(store.recordConnect(event)).resolves.toBeUndefined();
  expect(add).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledTimes(1);
});

test('応答しない書き込みは打ち切る', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const store = new FirestoreTelemetryStore({ add: () => new Promise(() => undefined), list: async () => [] });

  const pending = store.recordConnect({ projectId: 'alpha', sessionId: 's' });
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(pending).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
});
