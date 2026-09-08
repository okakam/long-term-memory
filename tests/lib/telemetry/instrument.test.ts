import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import type { MemoryService } from '@/lib/memory/service';
import { handleMcpRequest } from '@/lib/mcp/transport';
import { resetSessionState } from '@/lib/mcp/session';
import { resetTelemetryStore, setTelemetryStoreForTests, TelemetryStore } from '@/lib/telemetry/store';
import { measure } from '@/lib/telemetry/instrument';

let db: Database.Database | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await resetSessionState();
  resetTelemetryStore();
  db = undefined;
});

test('measure は response text の code point 数と配列件数だけを返す', () => {
  expect(measure({ content: [{ type: 'text', text: JSON.stringify([{ name: '😀' }]) }] })).toEqual({
    resultCount: 1,
    resultChars: 14,
  });
});

test('MCP initialize と tools/call は aggregate telemetry を記録する', async () => {
  vi.stubEnv('LTM_TELEMETRY', '1');
  db = new Database(':memory:');
  const telemetry = TelemetryStore.open(db);
  setTelemetryStoreForTests(telemetry);

  const memory = {
    id: 'memory-id',
    name: 'private-memory',
    description: 'private description',
    type: 'project' as const,
    tags: [],
    links: [],
    entities: [],
    triples: [],
    supersedes: [],
    body: 'PRIVATE BODY MUST NOT BE STORED',
    created_at: '2026-09-05T00:00:00.000Z',
    updated_at: '2026-09-05T00:00:00.000Z',
  };
  const service = {
    get: vi.fn(() => memory),
    supersededByMap: vi.fn(() => new Map()),
  } as unknown as MemoryService;

  const response = await handleMcpRequest(new Request(
    'https://example.test/api/mcp?project_id=project',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_memory', arguments: { id_or_name: 'private-memory', secret: 'TOKEN_VALUE' } },
      }),
    },
  ), { mode: 'vercel-stateless', service });
  expect(response.status).toBe(200);

  const rows = telemetry.rows();
  expect(rows.map((row) => row.event)).toEqual(['connect', 'tool_call']);
  expect(rows[0]).toMatchObject({ project_id: 'project', session_id: expect.any(String), tool: null, kind: null });
  expect(rows[1]).toMatchObject({ project_id: 'project', session_id: rows[0].session_id, tool: 'get_memory', kind: 'read', ok: 1 });
  expect(JSON.stringify(rows)).not.toContain('TOKEN_VALUE');
  expect(JSON.stringify(rows)).not.toContain('PRIVATE BODY');
});
