import { expect, test } from 'vitest';

import { createMcpServer } from '@/lib/mcp/server';

test('createMcpServer は 16 ツールを登録する', async () => {
  const server = createMcpServer({ projectId: 'project', svc: {} as never });
  const result = await server.server['_requestHandlers'].get('tools/list')?.({ method: 'tools/list', params: {} }, {} as never);
  expect(result?.tools).toHaveLength(16);
});
