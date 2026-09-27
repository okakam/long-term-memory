import { expect, test } from 'vitest';

import { FindRelatedInput, ForgetMemoryInput, GetMemoryIndexInput, GetMemoryInput, LinkMemoriesInput, ListByTypeInput, RememberFeedbackInput, RememberProjectFactInput, RememberReferenceInput, RememberSessionSummaryInput, RememberUserFactInput, ReindexInput, SearchByTagInput, SearchMemoriesInput, UpdateMemoryInput } from '@/lib/mcp/schemas';

test('KG 記憶の entities/why/how_to_apply は必須かつ非空', () => {
  expect(RememberUserFactInput.safeParse({ name: 'fact', description: 'd', body: 'b' }).success).toBe(false);
  expect(RememberUserFactInput.safeParse({ name: 'fact', description: 'd', body: 'b', entities: [] }).success).toBe(false);
  expect(RememberFeedbackInput.safeParse({ name: 'fact', description: 'd', body: 'b', entities: [{ name: 'Entity' }], why: '', how_to_apply: 'later' }).success).toBe(false);
  const parsed = RememberFeedbackInput.parse({ project_id: 'alpha', name: 'fact', description: 'd', body: 'b', entities: [{ name: 'Entity' }], why: 'because', how_to_apply: 'when needed' });
  expect(parsed.entities[0].aliases).toEqual([]);
});

test('全 scope tool は top-level project_id を必須とする', () => {
  const schemas = [FindRelatedInput, ForgetMemoryInput, GetMemoryIndexInput, GetMemoryInput, LinkMemoriesInput, ListByTypeInput, RememberFeedbackInput, RememberProjectFactInput, RememberReferenceInput, RememberSessionSummaryInput, RememberUserFactInput, ReindexInput, SearchByTagInput, SearchMemoriesInput, UpdateMemoryInput];
  for (const schema of schemas) {
    expect(schema.safeParse({}).success).toBe(false);
    expect('project_id' in schema.shape).toBe(true);
  }
  expect(ReindexInput.safeParse({ project_id: 'alpha' }).success).toBe(true);
  expect(ReindexInput.safeParse({ project_id: 'alpha', unexpected: true }).success).toBe(false);
});

test('名前付き schema field は description を持つ', () => {
  const shape = RememberFeedbackInput.shape;
  for (const key of ['name', 'description', 'body', 'entities', 'why', 'how_to_apply']) {
    expect(shape[key as keyof typeof shape].description).toBeTruthy();
  }
});
