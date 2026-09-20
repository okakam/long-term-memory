import { expect, test } from 'vitest';

import { rrfMerge } from '@/lib/memory/rrf';

test('rrfMerge は rank を融合し最初の list の object を残す', () => {
  const first = { id: 'same', source: 'project' };
  const second = { id: 'same', source: 'shared' };
  expect(rrfMerge([[first, { id: 'project-only' }], [second, { id: 'shared-only' }]], (item) => item.id))
    .toEqual([first, { id: 'project-only' }, { id: 'shared-only' }]);
});
