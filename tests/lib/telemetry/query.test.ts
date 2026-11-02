import { describe, expect, test } from 'vitest';

import { TOOL_CATALOG } from '@/lib/telemetry/catalog';
import { curatorStatus, dailySeries, perProject, perTool, summarize, visibleRows } from '@/lib/telemetry/query';
import type { TelemetryRow } from '@/lib/telemetry/store';
import { resolveTelemetryWindow } from '@/lib/telemetry/window';

const rows: TelemetryRow[] = [
  { id: 1, ts: '2026-09-05T15:01:00.000Z', event: 'connect', project_id: 'project', session_id: 's1', tool: null, kind: null, ok: 1, error_code: null, duration_ms: 1, result_count: null, result_chars: null, maintenance: 0 },
  { id: 2, ts: '2026-09-05T15:02:00.000Z', event: 'tool_call', project_id: 'project', session_id: 's1', tool: 'get_memory', kind: 'read', ok: 1, error_code: null, duration_ms: 2, result_count: 1, result_chars: 20, maintenance: 0 },
  { id: 3, ts: '2026-09-05T16:00:00.000Z', event: 'tool_call', project_id: 'project', session_id: null, tool: 'remember_project_fact', kind: 'write', ok: 0, error_code: 'validation', duration_ms: 3, result_count: 0, result_chars: 0, maintenance: 1 },
  { id: 4, ts: '2026-09-05T16:00:30.000Z', event: 'connect', project_id: 'other', session_id: 's2', tool: null, kind: null, ok: 1, error_code: null, duration_ms: 0, result_count: null, result_chars: null, maintenance: 0 },
  { id: 5, ts: '2026-09-05T16:01:00.000Z', event: 'tool_call', project_id: 'other', session_id: 's2', tool: 'remember_session_summary', kind: 'write', ok: 1, error_code: null, duration_ms: 3, result_count: 0, result_chars: 10, maintenance: 1 },
];

test('query は kind/error/attribution を集計する', () => {
  const summary = summarize(rows);
  expect(summary).toMatchObject({ calls: 3, connects: 2, reads: 1, writes: 2, errors: 1, unattributedCalls: 1, connectionsWithRead: 1 });
  expect(summary.readlessRate).toBeCloseTo(0.5);
  expect(summary.r1Suppressed).toBe(true);
  expect(perProject(rows)).toEqual(expect.arrayContaining([expect.objectContaining({ project_id: 'project', calls: 2 })]));
  const tools = perTool(rows);
  expect(tools).toHaveLength(16);
  expect(tools.find((tool) => tool.tool === 'link_memories')?.calls).toBe(0);
  expect(tools.find((tool) => tool.tool === 'get_memory')?.result_chars_p95).toBe(20);
  expect(curatorStatus(rows, new Date('2026-09-05T17:00:00.000Z'))).toMatchObject({ stale: false, lastWriteIso: '2026-09-05T16:01:00.000Z' });
});

test('dailySeries は zero-count day と write 限定 maintenance を返す', () => {
  const window = resolveTelemetryWindow(2, new Date('2026-09-05T17:00:00.000Z'));
  const series = dailySeries(rows, window);
  expect(series).toHaveLength(2);
  expect(series[1]).toMatchObject({ reads: 1, writes: 2, maintenanceWrites: 2 });
  expect(TOOL_CATALOG).toHaveLength(16);
});

describe('visibleRows', () => {
  const row = (fields: Partial<TelemetryRow>): TelemetryRow => ({
    id: 1, ts: '2026-11-01T00:00:00.000Z', event: 'tool_call', project_id: 'alpha', session_id: null, user_id: null,
    tool: 'get_memory', kind: 'read', ok: 1, error_code: null, duration_ms: 0, result_count: null, result_chars: null, maintenance: 0,
    ...fields,
  });
  const mineConnect = row({ event: 'connect', project_id: '__global__', session_id: 's1', user_id: 'me', tool: null, kind: null });
  const otherConnect = row({ event: 'connect', project_id: '__global__', session_id: 's2', user_id: 'other', tool: null, kind: null });
  const legacyConnect = row({ event: 'connect', project_id: '__global__', session_id: 's3', tool: null, kind: null });
  const mineList = row({ project_id: '__global__', session_id: 's1', user_id: 'me', tool: 'list_projects', kind: 'meta' });
  const otherList = row({ project_id: '__global__', session_id: 's2', user_id: 'other', tool: 'list_projects', kind: 'meta' });
  const alphaCall = row({ session_id: 's1' });
  const betaCall = row({ project_id: 'beta', session_id: 's4' });
  const rows = [mineConnect, otherConnect, legacyConnect, mineList, otherList, alphaCall, betaCall];

  test('全体表示ではアクセス可能なprojectと自分の__global__だけを返す', () => {
    expect(visibleRows(rows, { projectIds: new Set(['alpha']), userId: 'me' }))
      .toEqual([mineConnect, mineList, alphaCall]);
  });

  test('project絞り込みではそのprojectを呼んだ自分の接続を含める', () => {
    expect(visibleRows(rows, { projectIds: new Set(['alpha']), userId: 'me', selectedProject: 'alpha' }))
      .toEqual([mineConnect, alphaCall]);
    expect(visibleRows(rows, { projectIds: new Set(['beta']), userId: 'me', selectedProject: 'beta' }))
      .toEqual([betaCall]);
  });

  test('認証なしで絞り込みもなければ全件を返す', () => {
    expect(visibleRows(rows, {})).toEqual(rows);
  });
});
