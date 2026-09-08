import { afterEach, expect, test, vi } from 'vitest';

import type { MemoryService } from '@/lib/memory/service';
import type { Memory } from '@/lib/memory/types';
import { resetSessionState } from '@/lib/mcp/session';
import { handleMcpRequest } from '@/lib/mcp/transport';

const saved: Memory = {
  id: '01HZZZZZZZZZZZZZZZZZZZZZZ',
  name: 'feedback-memory',
  description: 'desc',
  type: 'feedback',
  tags: ['rule'],
  links: [],
  entities: [{ name: 'TypeScript', aliases: [] }],
  triples: [],
  supersedes: [],
  body: 'body\n\n**Why:** reason\n**How to apply:** trigger',
  created_at: '2026-09-05T00:00:00.000Z',
  updated_at: '2026-09-05T00:00:00.000Z',
};

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    saveAsync: vi.fn(async (_project: string, input: unknown) => ({ ...saved, ...(input as object) })),
    updateAsync: vi.fn(async () => saved),
    forgetAsync: vi.fn(async () => undefined),
    linkMemoriesAsync: vi.fn(async () => saved),
    get: vi.fn(() => saved),
    listSummaries: vi.fn(() => []),
    searchByTagSummaries: vi.fn(() => []),
    searchAssociative: vi.fn(() => []),
    findRelated: vi.fn(() => ({ nodes: [saved], truncated: false })),
    supersededByMap: vi.fn(() => new Map()),
    listProjects: vi.fn(() => []),
    reindex: vi.fn(),
    ...overrides,
  } as unknown as MemoryService;
}

async function call(service: MemoryService, name: string, arguments_: object, project = 'project') {
  const response = await handleMcpRequest(new Request(`https://example.test/api/mcp?project_id=${project}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } }),
  }), { mode: 'vercel-stateless', service });
  return response.json() as Promise<{ result: { content: Array<{ text: string }>; isError?: boolean } }> ;
}

afterEach(async () => { await resetSessionState(); });

test('feedback/project write は Why/How を body に合成して保存する', async () => {
  const service = makeService();
  const feedback = await call(service, 'remember_feedback', {
    name: 'feedback-memory', description: 'desc', body: 'body\n',
    entities: [{ name: 'TypeScript' }], why: 'reason', how_to_apply: 'trigger',
  });
  expect(feedback.result.content[0].text).toContain('saved feedback memory feedback-memory');
  expect((service.saveAsync as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
    type: 'feedback', body: 'body\n\n**Why:** reason\n**How to apply:** trigger',
  });
});

test('reference URL は末尾へ追記される', async () => {
  const service = makeService();
  await call(service, 'remember_reference', { name: 'reference-memory', description: 'desc', body: 'body\n\n', url: 'https://example.test/doc' });
  expect((service.saveAsync as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
    type: 'reference', body: 'body\n\nURL: https://example.test/doc',
  });
});

test('shared scope は maintenance gate 無しの write を拒否する', async () => {
  const service = makeService();
  const response = await call(service, 'remember_user_fact', {
    name: 'shared-memory', description: 'desc', body: 'body',
    entities: [{ name: 'Entity' }],
  }, '__shared__');
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toContain('shared scope is read-only');
  expect(service.saveAsync).not.toHaveBeenCalled();
});

test('get_memory は full body と project scope を text JSON で返す', async () => {
  const service = makeService();
  const response = await call(service, 'get_memory', { id_or_name: 'unused' });
  const value = JSON.parse(response.result.content[0].text);
  expect(value.body).toContain('**Why:** reason');
  expect(value.scope).toBe('project');
});

test('reindex は現在の project scope をサービスへ渡す', async () => {
  const service = makeService();
  await call(service, 'reindex', {});
  expect(service.reindex).toHaveBeenCalledWith('project');
});
