import { expect, test } from 'vitest';

import {
  assertSnapshotSafe,
  buildSnapshot,
  fetchRemoteSnapshot,
  type RemoteProject,
  type SnapshotMemory,
} from '../../scripts/curator/export-remote-snapshot';

const project: RemoteProject = {
  project_id: 'alpha',
  role: 'owner',
  created_at: '2026-09-05T00:00:00.000Z',
  updated_at: '2026-09-06T00:00:00.000Z',
};
const memory: SnapshotMemory = {
  projectId: 'alpha',
  id: 'mem_1',
  name: 'deployment-policy',
  type: 'project',
  description: 'Production deployment policy',
  body: 'Deploy after tests. Authorization: Bearer ltm_live_secret_123456.',
  why: 'Keep deployments reproducible',
  how_to_apply: 'Run the fixed CI workflow first.',
  tags: ['deploy'],
  links: [],
  source_refs: [],
  entities: [{ name: 'Cloud Run' }],
  triples: [['CI', 'protects', 'production']],
  created_at: '2026-09-05T00:00:00.000Z',
  updated_at: '2026-09-06T00:00:00.000Z',
};

test('remote snapshotはlist/index/getを呼び、認証ヘッダを転送する', async () => {
  const calls: Array<{ url: string; body: string; authorization?: string; id?: unknown }> = [];
  const result = await fetchRemoteSnapshot({
    baseUrl: 'https://memory.example',
    token: 'ltm_test_token_secret',
    fetcher: async (input, init) => {
      const body = String(init?.body ?? '');
      const request = JSON.parse(body) as { id?: unknown };
      calls.push({
        url: String(input),
        body,
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
        id: request.id,
      });
      if (body.includes('list_projects')) {
        return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify([project]) }] } }));
      }
      if (body.includes('get_memory_index')) {
        return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify([{
          id: memory.id,
          name: memory.name,
          type: memory.type,
          description: memory.description,
          body_chars: memory.body.length,
          tags: memory.tags,
          links: memory.links,
          updated_at: memory.updated_at,
          scope: 'project',
        }]) }] } }));
      }
      return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(memory) }] } }));
    },
  });

  expect(calls).toHaveLength(3);
  expect(calls.every((call) => call.url === 'https://memory.example/api/mcp')).toBe(true);
  expect(calls.every((call) => typeof call.id === 'string' && call.id.length > 0)).toBe(true);
  expect(calls.every((call) => call.authorization === 'Bearer ltm_test_token_secret')).toBe(true);
  const requests = calls.map((call) => JSON.parse(call.body) as { params?: { name?: string; arguments?: Record<string, unknown> } });
  const listProjects = requests.find((request) => request.params?.name === 'list_projects');
  const index = requests.find((request) => request.params?.name === 'get_memory_index');
  const get = requests.find((request) => request.params?.name === 'get_memory');
  expect(listProjects?.params?.arguments).toEqual({});
  expect(index?.params?.arguments).toMatchObject({ project_id: 'alpha', include_shared: false });
  expect(get?.params?.arguments).toMatchObject({ project_id: 'alpha', id_or_name: memory.name, include_shared: false });
  expect(result).toContain('# Remote memory snapshot');
  expect(result).toContain('- project_id: alpha');
  expect(result).toContain('  role: owner');
  expect(result).toContain('deployment-policy');
  expect(result).not.toContain('ltm_live_secret_123456');
  expect(result).toContain('[REDACTED]');
  expect(() => assertSnapshotSafe(result)).not.toThrow();
});

test('remote snapshotはMCP tool errorを失敗として扱う', async () => {
  await expect(fetchRemoteSnapshot({
    baseUrl: 'https://memory.example',
    token: 'ltm_test_token_secret',
    fetcher: async () => new Response(JSON.stringify({
      result: { isError: true, content: [{ type: 'text', text: 'project access denied' }] },
    })),
  })).rejects.toThrow('MCP tool error');
});

test('snapshotの安全検査は未サニタイズのtokenを拒否する', () => {
  expect(() => assertSnapshotSafe('Authorization: Bearer ltm_live_secret_123456')).toThrow();
  const safe = buildSnapshot([project], [memory]);
  expect(safe).not.toContain('ltm_live_secret_123456');
  expect(safe).toContain('shared_total_after');
});
