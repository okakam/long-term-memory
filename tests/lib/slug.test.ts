import { describe, expect, test } from 'vitest';

import {
  SHARED_PROJECT_ID,
  SlugError,
  assertMemoryName,
  assertProjectId,
  isReservedProjectId,
  isValidSlug,
} from '@/lib/slug';

describe('isValidSlug', () => {
  test.each(['a', 'project-1', 'a'.repeat(64)])('%s を受理する', (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });

  test.each(['', '-project', 'project-', 'two--parts', 'Upper', 'with_underscore', 'a'.repeat(65), '../escape'])('%s を拒否する', (slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });
});

test('__shared__ は予約 project_id としてのみ受理する', () => {
  expect(isValidSlug(SHARED_PROJECT_ID)).toBe(false);
  expect(isReservedProjectId(SHARED_PROJECT_ID)).toBe(true);
  expect(assertProjectId(SHARED_PROJECT_ID)).toBe(SHARED_PROJECT_ID);
  expect(() => assertMemoryName(SHARED_PROJECT_ID)).toThrow(SlugError);
});

test('assertProjectId と assertMemoryName は不正入力を field/value 付きで拒否する', () => {
  for (const [assertion, field] of [[assertProjectId, 'project_id'], [assertMemoryName, 'memory name']] as const) {
    try {
      assertion('../escape');
      throw new Error('expected SlugError');
    } catch (error) {
      expect(error).toBeInstanceOf(SlugError);
      expect(error).toMatchObject({ field, value: '../escape' });
      expect((error as Error).message).toBe(`invalid ${field}: ../escape (expected lowercase a-z, 0-9, hyphen-separated, 1..64 chars)`);
    }
  }
});

test('非文字列も安全に拒否する', () => {
  expect(isValidSlug(null)).toBe(false);
  expect(() => assertProjectId(null)).toThrow(SlugError);
  expect(() => assertMemoryName(1)).toThrow(SlugError);
});
