import { afterEach, expect, test, vi } from 'vitest';

import type { MemoryService } from '@/lib/memory/service';
import type { Memory, MemorySummary } from '@/lib/memory/types';
import { resetSessionState } from '@/lib/mcp/session';
import { handleMcpRequest } from '@/lib/mcp/transport';

function memory(name: string, type: Memory['type'] = 'project', scope = 'project'): Memory {
  return {
    id: 'id-' + scope + '-' + name,
    name,
    description: scope + ' ' + name,
    type,
    tags: ['tag'],
    links: [],
    entities: [],
    triples: [],
    supersedes: [],
    source_refs: [{ project_id: scope, memory: name }],
    body: scope + ' body',
    created_at: '2026-09-05T00:00:00.000Z',
    updated_at: '2026-09-05T00:00:00.000Z',
  };
}

function summary(item: Memory): MemorySummary {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    type: item.type,
    tags: item.tags,
    links: item.links,
    body_chars: item.body.length,
    updated_at: item.updated_at,
  };
}

async function call(service: MemoryService, name: string, arguments_: object, project = 'project') {
  const response = await handleMcpRequest(new Request(
    'https://example.test/api/mcp?project_id=' + project,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: arguments_ } }),
    },
  ), { mode: 'vercel-stateless', service });
  const body = await response.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
  if (!body.result?.content?.[0]) throw new Error('missing MCP result');
  return { response, body, value: JSON.parse(body.result.content[0].text) as unknown };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await resetSessionState();
});

test('shared read は project-first dedup、include_shared:false、get/fallback、source_refs を扱う', async () => {
  vi.stubEnv('LTM_TELEMETRY', '0');
  const project = memory('same', 'project', 'project');
  const projectOnly = memory('project-only', 'feedback', 'project');
  const sharedSame = memory('same', 'project', 'shared');
  const sharedOnly = memory('shared-only', 'user', 'shared');
  const service = {
    listSummaries: vi.fn((projectId: string, options?: { limit?: number; type?: string }) => {
      const values = projectId === 'project'
        ? [summary(project), summary(projectOnly)]
        : [summary(sharedSame), summary(sharedOnly)];
      return values.filter((item) => !options?.type || item.type === options.type).slice(0, options?.limit ?? values.length);
    }),
    searchByTagSummaries: vi.fn((projectId: string) => projectId === 'project' ? [summary(project)] : [summary(sharedSame), summary(sharedOnly)]),
    searchAssociative: vi.fn((projectId: string) => projectId === 'project' ? [project, projectOnly] : [sharedSame, sharedOnly]),
    get: vi.fn((projectId: string, id: string) => {
      if (projectId === 'project') {
        const error = new Error('memory not found');
        error.name = 'MemoryNotFoundError';
        throw error;
      }
      if (id === 'shared-only') return sharedOnly;
      throw new Error('memory not found');
    }),
    findRelated: vi.fn((projectId: string) => {
      if (projectId === 'project') {
        const error = new Error('memory not found');
        error.name = 'MemoryNotFoundError';
        throw error;
      }
      return { nodes: [sharedOnly], truncated: false };
    }),
    supersededByMap: vi.fn(() => new Map()),
  } as unknown as MemoryService;

  const list = await call(service, 'list_memories_by_type', { type: 'project' });
  expect((list.value as Array<{ name: string; scope: string }>).map((item) => item.name)).toEqual(['same']);
  expect((list.value as Array<{ scope: string }>).map((item) => item.scope)).toEqual(['project']);

  const noShared = await call(service, 'list_memories_by_type', { type: 'project', include_shared: false });
  expect(noShared.value).toEqual([expect.objectContaining({ name: 'same', scope: 'project' })]);

  const fallback = await call(service, 'get_memory', { id_or_name: 'shared-only' });
  expect(fallback.value).toEqual(expect.objectContaining({
    name: 'shared-only',
    scope: 'shared',
    source_refs: [{ project_id: 'shared', memory: 'shared-only' }],
  }));

  const related = await call(service, 'find_related', { id_or_name: 'shared-only' });
  expect(related.value).toEqual({ nodes: [expect.objectContaining({ name: 'shared-only', scope: 'shared' })], truncated: false });

  const search = await call(service, 'search_memories', { query: 'topic' });
  expect((search.value as Array<{ name: string; scope: string }>).map((item) => item.name)).toEqual(['same', 'project-only', 'shared-only']);
});

test('shared search/index はそれぞれ 10/50 件に制限し、shared current は再マージしない', async () => {
  vi.stubEnv('LTM_TELEMETRY', '0');
  const shared = Array.from({ length: 60 }, (_, index) => memory('shared-' + index, 'project', 'shared'));
  const service = {
    listSummaries: vi.fn((projectId: string, options?: { limit?: number }) => projectId === '__shared__'
      ? shared.slice(0, options?.limit ?? shared.length).map(summary)
      : []),
    searchAssociative: vi.fn((projectId: string) => projectId === '__shared__' ? shared : []),
    supersededByMap: vi.fn(() => new Map()),
  } as unknown as MemoryService;

  const search = await call(service, 'search_memories', { query: 'topic' });
  expect(search.value).toHaveLength(10);
  const index = await call(service, 'get_memory_index', {});
  expect(index.value).toHaveLength(50);

  const current = await call(service, 'search_memories', { query: 'topic' }, '__shared__');
  expect(current.value).toHaveLength(60);
  expect(service.searchAssociative).toHaveBeenCalledTimes(3);
});
