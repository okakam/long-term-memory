import { afterEach, expect, test, vi } from 'vitest';

import type { MemoryService } from '@/lib/memory/service';
import { resetSessionState } from '@/lib/mcp/session';
import { handleMcpRequest } from '@/lib/mcp/transport';

async function call(service: MemoryService, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-ltm-maintenance-token'] = token;
  const response = await handleMcpRequest(new Request(
    'https://example.test/api/mcp?project_id=__shared__',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'remember_user_fact',
          arguments: { name: 'shared-fact', description: 'desc', body: 'body', entities: [{ name: 'Entity' }] },
        },
      }),
    },
  ), { mode: 'vercel-stateless', service });
  return response.json() as Promise<{ result: { content: Array<{ text: string }>; isError?: boolean } }>;
}

function service() {
  return {
    saveAsync: vi.fn(async () => ({
      id: 'memory-id',
      name: 'shared-fact',
      description: 'desc',
      type: 'user',
      tags: [],
      links: [],
      entities: [{ name: 'Entity', aliases: [] }],
      triples: [],
      supersedes: [],
      body: 'body',
      created_at: '2026-09-05T00:00:00.000Z',
      updated_at: '2026-09-05T00:00:00.000Z',
    })),
  } as unknown as MemoryService;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await resetSessionState();
});

test('shared write は無効 token を拒否し、token 値を MCP 応答へ出さない', async () => {
  vi.stubEnv('LTM_TELEMETRY', '0');
  vi.stubEnv('LTM_MAINTENANCE_TOKEN', 'correct-token');
  const svc = service();
  const result = await call(svc, 'wrong-token');
  expect(result.result.isError).toBe(true);
  expect(result.result.content[0].text).toContain('shared scope is read-only');
  expect(result.result.content[0].text).not.toContain('wrong-token');
  expect(svc.saveAsync).not.toHaveBeenCalled();
});

test('shared write は timing-safe な完全一致 token のときだけ許可する', async () => {
  vi.stubEnv('LTM_TELEMETRY', 'correct-token');
  vi.stubEnv('LTM_MAINTENANCE_TOKEN', 'correct-token');
  const svc = service();
  const result = await call(svc, 'correct-token');
  expect(result.result.isError).not.toBe(true);
  expect(result.result.content[0].text).toContain('saved user memory shared-fact');
  expect(svc.saveAsync).toHaveBeenCalledTimes(1);
});
