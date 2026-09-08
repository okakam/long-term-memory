import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

import { migrateTelemetry } from '@/lib/telemetry/migrate';

test('telemetry schema はイベント履歴を保持し 13 列を持つ', () => {
  const db = new Database(':memory:');
  try {
    migrateTelemetry(db);
    const columns = db.prepare('PRAGMA table_info(tool_events)').all().map((row) => (row as { name: string }).name);
    expect(columns).toEqual(['id', 'ts', 'event', 'project_id', 'session_id', 'tool', 'kind', 'ok', 'error_code', 'duration_ms', 'result_count', 'result_chars', 'maintenance']);
    db.prepare('INSERT INTO tool_events (ts, event, project_id, ok, duration_ms, maintenance) VALUES (?, ?, ?, ?, ?, ?)')
      .run('2026-09-06T00:00:00.000Z', 'connect', 'project', 1, 1, 0);
    migrateTelemetry(db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tool_events').get()).toMatchObject({ count: 1 });
  } finally { db.close(); }
});
