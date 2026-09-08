import { expect, test } from 'vitest';

import {
  assertSnapshotSafe,
  buildSnapshot,
  fetchRemoteSnapshot,
  type RemoteProject,
  type SnapshotMemory,
} from '../../scripts/curator/export-remote-snapshot';

const project: RemoteProject = { id: 'alpha', count: 1, last_update: '2026-09-06T00:00:00.000Z' };
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
  entities: [{ name: 'Vercel' }],
  triples: [['CI', 'protects', 'production']],
  created_at: '2026-09-05T00:00:00.000Z',
  updated_at: '2026-09-06T00:00:00.000Z',
};

test('remote snapshotはlist/index/getを呼び、認証ヘッダを転送する', async () => {
  const calls: Array<{ url: string; body: string; authorization?: string }> = [];
  const result = await fetchRemoteSnapshot({
    baseUrl: 'https://memory.example',
    token: 'ltm_test_token_secret',
    fetcher: async (input, init) => {
      const body = String(init?.body ?? '');
      calls.push({
        url: String(input),
        body,
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
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
  expect(calls.every((call) => call.authorization === 'Bearer ltm_test_token_secret')).toBe(true);
  expect(calls.some((call) => call.body.includes('list_projects'))).toBe(true);
  expect(calls.some((call) => call.body.includes('get_memory_index'))).toBe(true);
  expect(calls.some((call) => call.body.includes('get_memory'))).toBe(true);
  expect(result).toContain('# Remote memory snapshot');
  expect(result).toContain('deployment-policy');
  expect(result).not.toContain('ltm_live_secret_123456');
  expect(result).toContain('[REDACTED]');
  expect(() => assertSnapshotSafe(result)).not.toThrow();
});

test('snapshotの安全検査は未サニタイズのtokenを拒否する', () => {
  expect(() => assertSnapshotSafe('Authorization: Bearer ltm_live_secret_123456')).toThrow();
  const safe = buildSnapshot([project], [memory]);
  expect(safe).not.toContain('ltm_live_secret_123456');
  expect(safe).toContain('shared_total_after');
});
