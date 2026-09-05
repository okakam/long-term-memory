import { afterEach, expect, test } from 'vitest';

import type { MemoryService } from '@/lib/memory/service';
import { resetSessionState } from '@/lib/mcp/session';
import { handleMcpRequest } from '@/lib/mcp/transport';

const service = {
  listProjects: () => [],
} as unknown as MemoryService;

async function call(message: object, mode: 'local-session' | 'vercel-stateless' = 'vercel-stateless') {
  return handleMcpRequest(new Request('https://example.test/api/mcp?project_id=stateless', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  }), { mode, service });
}

afterEach(async () => {
  await resetSessionState();
});

test('stateless invocation は initialize/list/call を別々に処理する', async () => {
  const initialized = await call({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.1.0' },
    },
  });
  expect(initialized.status).toBe(200);
  expect((await initialized.json()).result.serverInfo.name).toBe('long-term-memory');

  const listed = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  expect(listed.status).toBe(200);
  expect((await listed.json()).result.tools).toHaveLength(16);

  const called = await call({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list_projects', arguments: {} },
  });
  expect(called.status).toBe(200);
  expect((await called.json()).result.content).toEqual([{ type: 'text', text: '[]' }]);
});


test('local-session は外部 initialize 後の後続 request を同じ server で処理する', async () => {
  const initialized = await call({
    jsonrpc: '2.0', id: 10, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'client', version: '1' } },
  }, 'local-session');
  expect(initialized.status).toBe(200);
  const listed = await call({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }, 'local-session');
  expect(listed.status).toBe(200);
  expect((await listed.json()).result.tools).toHaveLength(16);
});

test('notification は 202 で本文を返さない', async () => {
  const response = await call({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  expect(response.status).toBe(202);
  expect(await response.text()).toBe('');
});


test('tool response timeout は HTTP 200 の JSON-RPC -32000 を返す', async () => {
  const hanging = {
    saveAsync: () => new Promise<never>(() => undefined),
  } as unknown as MemoryService;
  const response = await handleMcpRequest(new Request('https://example.test/api/mcp?project_id=timeout', {
    method: 'POST', body: JSON.stringify({
      jsonrpc: '2.0', id: 99, method: 'tools/call',
      params: { name: 'remember_user_fact', arguments: {
        name: 'timeout-memory', description: 'desc', body: 'body', entities: [{ name: 'Entity' }],
      } },
    }),
  }), { mode: 'vercel-stateless', service: hanging, timeoutMs: 10 });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: 99, error: { code: -32000, message: 'timeout waiting for MCP response' } });
});

test('method guard と project_id guard は HTTP error を返す', async () => {
  const get = await handleMcpRequest(new Request('https://example.test/api/mcp?project_id=stateless'));
  expect(get.status).toBe(405);
  const missing = await handleMcpRequest(new Request('https://example.test/api/mcp', { method: 'POST', body: '{}' }));
  expect(missing.status).toBe(400);
});
