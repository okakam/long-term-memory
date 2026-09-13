import { expect, test } from 'vitest';

import { runCleanReindex } from '../../scripts/eval/clean-reindex';

test('clean reindex は copied Markdown だけから全受け入れフィールドを復元する', () => {
  expect(runCleanReindex()).toEqual({
    memories: 3,
    fields: ['tags', 'links', 'entities', 'triples', 'body_chars', 'supersedes'],
  });
});
