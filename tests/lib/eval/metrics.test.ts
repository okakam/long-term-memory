import { expect, test } from 'vitest';

import { recallAtK, reciprocalRank } from '@/lib/eval/metrics';

test('recallAtK と reciprocalRank は relevant set を計測する', () => {
  expect(recallAtK(['a', 'b', 'c'], ['b', 'c'], 2)).toBe(0.5);
  expect(recallAtK([], [], 5)).toBe(0);
  expect(reciprocalRank(['x', 'b'], ['b'])).toBe(0.5);
  expect(reciprocalRank(['x'], ['b'])).toBe(0);
});
