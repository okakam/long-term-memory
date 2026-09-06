import { expect, test } from 'vitest';

import { filterKgGraph, kgNeighbors, MEMORIES_ONLY_FILTERS } from '@/lib/graph/kg-view';
import { buildKgGraph } from '@/lib/graph/builder';

const graph = buildKgGraph({
  memories: [
    { id: 'm1', name: 'first', type: 'project' as const, description: 'one', tags: ['keep'] },
    { id: 'm2', name: 'second', type: 'feedback' as const, description: 'two', tags: [] },
  ],
  entities: [{ id: 'e1', name: 'Entity' }],
  memberships: [{ memoryId: 'm1', entityId: 'e1' }],
  edges: [],
  links: [{ srcMemoryId: 'm1', dstName: 'second' }],
});

test('filterKgGraph は node を先に絞り、両端が残る edge だけを残す', () => {
  const filtered = filterKgGraph(graph, MEMORIES_ONLY_FILTERS);
  expect(filtered.nodes.map((node) => node.id)).toEqual(['m1', 'm2']);
  expect(filtered.edges).toEqual([expect.objectContaining({ kind: 'link', source: 'm1', target: 'm2' })]);

  const tagged = filterKgGraph(graph, { ...MEMORIES_ONLY_FILTERS, tags: ['keep'] });
  expect(tagged.nodes.map((node) => node.id)).toEqual(['m1']);
  expect(tagged.edges).toEqual([]);
});

test('kgNeighbors は自身と直接隣接する node のみ返す', () => {
  expect(kgNeighbors(graph, 'm1')).toEqual(new Set(['m1', 'ent:e1', 'm2']));
});
