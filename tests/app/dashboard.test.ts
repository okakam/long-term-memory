import Database from 'better-sqlite3';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';

import DashboardPage from '@/app/dashboard/page';
import { resetTelemetryStore, setTelemetryStoreForTests, TelemetryStore } from '@/lib/telemetry/store';

let db: Database.Database | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  resetTelemetryStore();
  db = undefined;
});

test('dashboard は JST 窓、7/30/90 プリセット、日次系列、全 tool catalog を表示する', async () => {
  vi.stubEnv('AUTH_REQUIRED', '0');
  vi.stubEnv('VERCEL', '0');
  db = new Database(':memory:');
  const telemetry = TelemetryStore.open(db);
  setTelemetryStoreForTests(telemetry);
  const now = new Date().toISOString();
  telemetry.recordConnect({ projectId: 'project', sessionId: 'session', ts: now });
  telemetry.recordToolCall({
    projectId: 'project',
    sessionId: 'session',
    tool: 'get_memory',
    kind: 'read',
    ok: true,
    durationMs: 4,
    resultCount: 1,
    resultChars: 12,
    ts: now,
  });

  const html = renderToStaticMarkup(await DashboardPage({
    searchParams: Promise.resolve({ days: '999', project: 'project' }),
  }));
  expect(html).toContain('（JST・365日）');
  expect(html).toContain('/dashboard?days=7&amp;project=project');
  expect(html).toContain('/dashboard?days=30&amp;project=project');
  expect(html).toContain('/dashboard?days=90&amp;project=project');
  expect(html).toContain('get_memory');
  expect(html).toContain('readless connection');
  expect((html.match(/<time /g) ?? []).length).toBe(365);
});
