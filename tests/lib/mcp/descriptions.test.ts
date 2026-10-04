import { afterEach, expect, test } from 'vitest';

import type { MemoryService } from '@/lib/memory/service';
import { resetSessionState } from '@/lib/mcp/session';
import { handleMcpRequest } from '@/lib/mcp/transport';

const service = { listProjects: () => [] } as unknown as MemoryService;

function collectNamedDescriptions(schema: Record<string, unknown>, result: string[] = []): string[] {
  const properties = schema.properties;
  if (properties && typeof properties === 'object') {
    for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
      if (value && typeof value === 'object') {
        result.push(`${name}:${String((value as Record<string, unknown>).description ?? '')}`);
        collectNamedDescriptions(value as Record<string, unknown>, result);
      }
    }
  }
  for (const key of ['items', 'additionalProperties']) {
    const value = schema[key];
    if (value && typeof value === 'object') collectNamedDescriptions(value as Record<string, unknown>, result);
  }
  for (const key of ['prefixItems', 'anyOf', 'oneOf', 'allOf']) {
    const value = schema[key];
    if (Array.isArray(value)) for (const item of value) if (item && typeof item === 'object') collectNamedDescriptions(item as Record<string, unknown>, result);
  }
  return result;
}

test('全 MCP tool の description と named input field description が配信される', async () => {
  const response = await handleMcpRequest(new Request('https://example.test/api/mcp', {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }), { mode: 'stateless', service });
  const tools = (await response.json()).result.tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  expect(tools).toHaveLength(17);
  expect(tools.every((tool) => tool.description.length > 0)).toBe(true);
  for (const tool of tools) expect(collectNamedDescriptions(tool.inputSchema).every((item) => item.split(':', 2)[1].length > 0)).toBe(true);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const tool of tools.filter((tool) => !['list_projects', 'setup_client_environment'].includes(tool.name))) {
    expect(tool.inputSchema.required).toContain('project_id');
    expect((tool.inputSchema.properties as Record<string, unknown>)?.project_id).toBeTruthy();
    expect(tool.description).toContain('list_projects');
    expect(tool.description).toContain('project_id');
  }
  const setup = byName.get('setup_client_environment')!;
  expect(setup.inputSchema.required).toEqual(['client']);
  expect((setup.inputSchema.properties as Record<string, unknown>).project_id).toBeUndefined();
  for (const name of ['remember_user_fact', 'remember_feedback', 'remember_project_fact']) {
    const tool = byName.get(name)!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['name', 'description', 'body', 'entities']));
  }
  expect(byName.get('remember_feedback')!.inputSchema.required).toEqual(expect.arrayContaining(['why', 'how_to_apply']));
  expect(byName.get('remember_project_fact')!.description).toContain('remember_session_summary');
});

afterEach(async () => { await resetSessionState(); });
