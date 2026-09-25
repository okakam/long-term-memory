import { expect, test } from 'vitest';

import { createMcpServer } from '@/lib/mcp/server';

test('createMcpServer は 16 ツールを登録する', async () => {
  const server = createMcpServer({ projectId: 'project', svc: {} as never });
  const result = await server.server['_requestHandlers'].get('tools/list')?.({ method: 'tools/list', params: {} }, {} as never);
  expect(result?.tools).toHaveLength(16);
});

test('Codex 向けの書き込みスキーマは tuple 形式を公開せず、triples を固定長文字列配列で表す', async () => {
  const server = createMcpServer({ projectId: 'project', svc: {} as never });
  const result = await server.server['_requestHandlers'].get('tools/list')?.({ method: 'tools/list', params: {} }, {} as never);
  const tools = new Map(result?.tools?.map((tool: { name: string; inputSchema: unknown }) => [tool.name, tool.inputSchema]));
  const containsTupleSchema = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsTupleSchema);
    if (typeof value !== 'object' || value === null) return false;
    const schema = value as Record<string, unknown>;
    return Array.isArray(schema.items)
      || Array.isArray(schema.prefixItems)
      || Object.values(schema).some(containsTupleSchema);
  };

  for (const name of ['remember_user_fact', 'remember_feedback', 'remember_project_fact', 'update_memory']) {
    const inputSchema = tools.get(name) as Record<string, unknown> | undefined;
    expect(inputSchema, `${name} should be registered`).toBeDefined();
    expect(containsTupleSchema(inputSchema), `${name} should not advertise tuple items`).toBe(false);
  }

  const projectSchema = tools.get('remember_project_fact') as {
    properties: { triples: { items: { type: string; minItems: number; maxItems: number; items: { type: string } } } };
  };
  expect(projectSchema.properties.triples.items).toMatchObject({
    type: 'array',
    minItems: 3,
    maxItems: 3,
    items: { type: 'string' },
  });

  const updateSchema = tools.get('update_memory') as {
    properties: { patch: { properties: { triples: { items: { type: string; minItems: number; maxItems: number; items: { type: string } } } } } };
  };
  expect(updateSchema.properties.patch.properties.triples.items).toMatchObject({
    type: 'array',
    minItems: 3,
    maxItems: 3,
    items: { type: 'string' },
  });
});
