import { expect, test } from 'vitest';

import { runCleanReindex } from '../../scripts/eval/clean-reindex';

test('clean reindex は copied Markdown だけから全 persisted/frontmatter 受け入れフィールドを復元し LTM_HOME を戻す', () => {
  const original = process.env.LTM_HOME;
  process.env.LTM_HOME = '/tmp/clean-reindex-original-home';
  try {
    expect(runCleanReindex()).toEqual({
      memories: 3,
      fields: ['description', 'tags', 'links', 'entities', 'triples', 'source_refs', 'body_chars', 'supersedes', 'created_at', 'updated_at'],
    });
    expect(process.env.LTM_HOME).toBe('/tmp/clean-reindex-original-home');
  } finally {
    if (original === undefined) delete process.env.LTM_HOME;
    else process.env.LTM_HOME = original;
  }
});
