import { expect, test } from 'vitest';

import { buildKgGraph } from '@/lib/graph/builder';

const data = {
  memories: [
    { id: 'm1', name: 'first-memory', type: 'project' as const, description: 'first', tags: ['keep'] },
    { id: 'm2', name: 'second-memory', type: 'feedback' as const, description: 'second', tags: [] },
  ],
  entities: [{ id: 'e1', name: 'TypeScript' }, { id: 'e2', name: 'Next.js' }],
  memberships: [{ memoryId: 'm1', entityId: 'e1' }],
  edges: [{ srcEntityId: 'e1', dstEntityId: 'e2', relation: 'uses' }],
  links: [
    { srcMemoryId: 'm1', dstName: 'second-memory' },
    { srcMemoryId: 'm2', dstName: 'missing-memory' },
  ],
};

test('buildKgGraph は memory/entity と membership/triple/link を仕様 ID へ変換する', () => {
  const graph = buildKgGraph(data);
  expect(graph.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'm1', kind: 'memory', data: expect.objectContaining({ label: 'first-memory', memoryType: 'project' }) }),
    expect.objectContaining({ id: 'ent:e1', kind: 'entity', data: { label: 'TypeScript' } }),
  ]));
  expect(graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'mem:m1->e1', source: 'm1', target: 'ent:e1', kind: 'membership', weight: 1 }),
    expect.objectContaining({ id: 'tri:e1->e2:uses', source: 'ent:e1', target: 'ent:e2', label: 'uses', kind: 'triple', weight: 1 }),
    expect.objectContaining({ id: 'lnk:m1->m2', source: 'm1', target: 'm2', kind: 'link', weight: 2 }),
  ]));
  expect(graph.edges.some((edge) => edge.id.includes('missing'))).toBe(false);
});
