import { expect, test } from 'vitest';

import { personalizedPageRank, type WeightedGraph } from '@/lib/graph/ppr';

const graph: WeightedGraph = {
  nodes: ['a', 'b', 'c'],
  adjacency: new Map([
    ['a', [{ to: 'b', w: 1 }]],
    ['b', [{ to: 'a', w: 1 }, { to: 'c', w: 1 }]],
    ['c', []],
  ]),
};

test('personalizedPageRank は seed を優先し dangling mass を保存する', () => {
  const scores = personalizedPageRank(graph, ['a']);
  expect(scores.get('a')!).toBeGreaterThan(scores.get('c')!);
  expect([...scores.values()].reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
});

test('personalizedPageRank は未知・空 seed を無視して孤立 seed を処理する', () => {
  expect(personalizedPageRank(graph, [])).toEqual(new Map());
  expect(personalizedPageRank(graph, ['unknown'])).toEqual(new Map());
  expect(personalizedPageRank({ nodes: ['isolated'], adjacency: new Map([['isolated', []]]) }, ['isolated']).get('isolated')).toBeCloseTo(1, 6);
});
