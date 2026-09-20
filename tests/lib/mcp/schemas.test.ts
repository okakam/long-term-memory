import { expect, test } from 'vitest';

import { RememberFeedbackInput, RememberUserFactInput, ReindexInput } from '@/lib/mcp/schemas';

test('KG 記憶の entities/why/how_to_apply は必須かつ非空', () => {
  expect(RememberUserFactInput.safeParse({ name: 'fact', description: 'd', body: 'b' }).success).toBe(false);
  expect(RememberUserFactInput.safeParse({ name: 'fact', description: 'd', body: 'b', entities: [] }).success).toBe(false);
  expect(RememberFeedbackInput.safeParse({ name: 'fact', description: 'd', body: 'b', entities: [{ name: 'Entity' }], why: '', how_to_apply: 'later' }).success).toBe(false);
  const parsed = RememberFeedbackInput.parse({ name: 'fact', description: 'd', body: 'b', entities: [{ name: 'Entity' }], why: 'because', how_to_apply: 'when needed' });
  expect(parsed.entities[0].aliases).toEqual([]);
});

test('ReindexInput は空 object だけを受理する', () => {
  expect(ReindexInput.safeParse({}).success).toBe(true);
  expect(ReindexInput.safeParse({ unexpected: true }).success).toBe(false);
});

test('名前付き schema field は description を持つ', () => {
  const shape = RememberFeedbackInput.shape;
  for (const key of ['name', 'description', 'body', 'entities', 'why', 'how_to_apply']) {
    expect(shape[key as keyof typeof shape].description).toBeTruthy();
  }
});
