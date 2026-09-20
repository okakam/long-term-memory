import { expect, test } from 'vitest';

import { parseMemoryString, serializeMemory } from '@/lib/markdown/frontmatter';
import { MemorySchema, type Memory } from '@/lib/memory/types';

const base: Memory = {
  id: 'id',
  name: 'new-memory',
  description: 'description',
  type: 'project',
  tags: [],
  links: [],
  entities: [],
  triples: [],
  supersedes: [],
  body: 'body',
  created_at: '2026-05-20T06:10:27.105Z',
  updated_at: '2026-06-02T07:51:42.244Z',
};

test('非空の supersedes をシリアライズして往復する', () => {
  const serialized = serializeMemory({ ...base, supersedes: ['old-memory'] });
  expect(serialized).toContain(`supersedes:
  - old-memory
---`);
  expect(parseMemoryString(serialized).supersedes).toEqual(['old-memory']);
});

test('空の supersedes は frontmatter から省略し読み込み時に空配列へ戻す', () => {
  const serialized = serializeMemory(base);
  expect(serialized).not.toContain('supersedes:');
  expect(parseMemoryString(serialized).supersedes).toEqual([]);
});

test('配列でない supersedes と非文字列・空文字の要素を捨てる', () => {
  const invalidArray = serializeMemory(base).replace('---\nbody', `supersedes:
  - old-memory
  - ''
  - 1
---
body`);
  expect(parseMemoryString(invalidArray).supersedes).toEqual(['old-memory']);

  const nonArray = serializeMemory(base).replace('---\nbody', `supersedes: old-memory
---
body`);
  expect(parseMemoryString(nonArray).supersedes).toEqual([]);
});

test('MemorySchema は空文字の supersedes 要素を拒否する', () => {
  expect(() => MemorySchema.parse({ ...base, supersedes: [''] })).toThrow();
});
