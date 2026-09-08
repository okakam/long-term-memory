import { expect, test } from 'vitest';

import { decayFactor, HALF_LIFE_DAYS, normalizeRelevance, RECENCY_WEIGHT, rerank, SUPERSEDED_PENALTY } from '@/lib/memory/rerank';

test('decayFactor は半減期と未来日・不正日付を契約どおり扱う', () => {
  const now = new Date('2026-09-05T00:00:00Z');
  expect(HALF_LIFE_DAYS.user).toBeNull();
  expect(decayFactor('2025-09-05T00:00:00Z', now, 'user')).toBe(1);
  expect(decayFactor('2026-07-07T00:00:00Z', now, 'project')).toBeCloseTo(0.5, 6);
  expect(decayFactor('2026-09-06T00:00:00Z', now, 'project')).toBe(1);
  expect(decayFactor('invalid', now, 'project')).toBe(1);
});

test('normalizeRelevance は空・単一・同点を 1 とする', () => {
  expect(normalizeRelevance([])).toEqual([]);
  expect(normalizeRelevance([3])).toEqual([1]);
  expect(normalizeRelevance([3, 3])).toEqual([1, 1]);
  expect(normalizeRelevance([1, 3])).toEqual([0, 1]);
});

test('rerank は新しさと superseded penalty を関連度差の上限内で適用する', () => {
  const now = new Date('2026-09-05T00:00:00Z');
  const items = [
    { id: 'old', relevance: 0.5, updated_at: '2026-01-01T00:00:00Z', type: 'project' as const, superseded: true },
    { id: 'new', relevance: 0.5, updated_at: '2026-09-04T00:00:00Z', type: 'project' as const, superseded: false },
  ];
  expect(rerank(items, now).map((item) => item.id)).toEqual(['new', 'old']);
  expect(RECENCY_WEIGHT).toBe(0.2);
  expect(SUPERSEDED_PENALTY).toBe(0.5);
});
