import { afterEach, expect, test, vi } from 'vitest';

import type { MemoryService } from '@/lib/memory/service';
import type { McpPrincipal } from '@/lib/mcp/principal';
import { createMcpSession, resetSessionState } from '@/lib/mcp/session';
import { instrumentRegistrar } from '@/lib/telemetry/instrument';
import { handleMcpRequest } from '@/lib/mcp/transport';
import { resetTelemetryStore, setTelemetryStoreForTests, TelemetryStore } from '@/lib/telemetry/store';

const service = { listProjects: () => [] } as unknown as MemoryService;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function post(message: object, sessionId?: string) {
  return handleMcpRequest(new Request('https://example.test/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify(message),
  }), { mode: 'stateless', service });
}

const initialize = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'client', version: '1' } },
};
const listProjects = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_projects', arguments: {} } };

function setup() {
  const telemetry = TelemetryStore.openDefault();
  setTelemetryStoreForTests(telemetry);
  return telemetry;
}

afterEach(async () => {
  await resetSessionState();
  resetTelemetryStore();
});

test('initializeはUUIDのMcp-Session-Idを返し、そのIDでconnectを1件記録する', async () => {
  const telemetry = setup();
  const response = await post(initialize);
  const issued = response.headers.get('mcp-session-id');
  expect(issued).toMatch(UUID);
  expect(telemetry.rows()).toMatchObject([{ event: 'connect', session_id: issued }]);
});

test('initialize以外の呼び出しはconnectを記録せず、送られたsession IDへ帰属する', async () => {
  const telemetry = setup();
  const issued = (await post(initialize)).headers.get('mcp-session-id')!;
  await post(listProjects, issued);
  await post(listProjects, issued);
  const rows = telemetry.rows();
  expect(rows.filter((row) => row.event === 'connect')).toHaveLength(1);
  expect(rows.filter((row) => row.event === 'tool_call').map((row) => row.session_id)).toEqual([issued, issued]);
});

test('session IDなしの呼び出しは、直前の別接続へ帰属させず未帰属にする', async () => {
  const telemetry = setup();
  await post(initialize);
  await post(listProjects);
  expect(telemetry.rows().find((row) => row.event === 'tool_call')?.session_id).toBeNull();
});

test('UUID形式でないsession IDは保存しない', async () => {
  const telemetry = setup();
  await post(listProjects, 'private-memory-name');
  expect(telemetry.rows()[0].session_id).toBeNull();
  expect(JSON.stringify(telemetry.rows())).not.toContain('private-memory-name');
});

test('connectには接続したユーザーのUIDを保存する', async () => {
  const telemetry = setup();
  const session = await createMcpSession({
    svc: service, principal: { userId: 'user-1' } as McpPrincipal, requireProjectAccess: async () => undefined,
  });
  await session.acceptInitialize(initialize as never);
  await session.close();
  expect(telemetry.rows()).toMatchObject([{ event: 'connect', project_id: '__global__', user_id: 'user-1' }]);
});

test('UIDはproject指定のないtool callにだけ渡す', async () => {
  const handlers = new Map<string, (input: unknown, extra: unknown) => Promise<unknown>>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: (input: unknown, extra: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  };
  const record = vi.fn(async () => undefined);
  instrumentRegistrar(server as never, 'read', record, {
    userId: 'user-1',
    projectIdForInput: (input) => (input as { project_id?: string }).project_id ?? '__global__',
  });
  server.registerTool('get_memory', {}, async () => ({}));
  await handlers.get('get_memory')!({ project_id: 'alpha' }, {});
  await handlers.get('get_memory')!({}, {});
  expect(record.mock.calls.map(([event]: unknown[]) => (event as { userId?: string | null }).userId))
    .toEqual([null, 'user-1']);
});
