import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import { TelemetryStore } from '@/lib/telemetry/store';
import { recordConnect, recordToolCall, resetRecorderState } from '@/lib/telemetry/recorder';
import { setTelemetryStoreForTests } from '@/lib/telemetry/store';

let db: Database.Database | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  resetRecorderState();
  db?.close();
  db = undefined;
});

async function setup() {
  db = new Database(':memory:');
  const store = TelemetryStore.open(db);
  setTelemetryStoreForTests(store);
  return store;
}

test('recorder は opt-out と障害を MCP 応答へ伝播せず、raw data を保存しない', async () => {
  const store = await setup();
  process.env.LTM_TELEMETRY = '0';
  await recordToolCall({ projectId: 'project', tool: 'get_memory', kind: 'read', ok: true, durationMs: 4, resultCount: 1, resultChars: 30, error: new Error('SECRET BODY') });
  expect(store.rows()).toHaveLength(0);
  delete process.env.LTM_TELEMETRY;
  await recordToolCall({ projectId: 'project', tool: 'get_memory', kind: 'read', ok: false, durationMs: 4, error: new Error('memory not found: secret-name') });
  const rows = store.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).not.toMatchObject({ error_code: 'secret-name' });
  expect(rows[0].error_code).toBe('not_found');
  expect(JSON.stringify(rows[0])).not.toContain('SECRET BODY');
});

test('connect は session id を記録する', async () => {
  const store = await setup();
  await recordConnect({ projectId: 'project', sessionId: 'session-1' });
  expect(store.rows()[0]).toMatchObject({ event: 'connect', session_id: 'session-1', tool: null, kind: null });
});
