import { describe, expect, test } from 'vitest';

import { DEFAULT_MAINTENANCE_SETTINGS, deriveLegacyReview, reviewSchedule } from '@/lib/maintenance/policy';
import type { Memory } from '@/lib/memory/types';

describe('reviewSchedule', () => {
  test('project の初期見直し期限は作成から90日後', () => {
    expect(reviewSchedule('project', '2026-01-01T00:00:00.000Z', DEFAULT_MAINTENANCE_SETTINGS))
      .toEqual({ last_reviewed_at: '2026-01-01T00:00:00.000Z', next_review_at: '2026-04-01T00:00:00.000Z' });
  });

  test('種別ごとの周期を使い、session は作成日時からarchive期限を導く', () => {
    expect(reviewSchedule('reference', '2026-01-01T00:00:00.000Z', DEFAULT_MAINTENANCE_SETTINGS).next_review_at)
      .toBe('2026-06-30T00:00:00.000Z');
    expect(reviewSchedule('user', '2026-01-01T00:00:00.000Z', DEFAULT_MAINTENANCE_SETTINGS).next_review_at)
      .toBe('2027-01-01T00:00:00.000Z');
    const session: Memory = {
      id: 'session-id', name: 'session', description: 'd', type: 'session', tags: [], links: [],
      entities: [], triples: [], supersedes: [], body: 'updated later',
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-05-01T00:00:00.000Z',
    };
    expect(deriveLegacyReview(session, DEFAULT_MAINTENANCE_SETTINGS)).toBe('2026-04-01T00:00:00.000Z');
  });

  test('project別周期の変更を次の予定日へ反映し、不正日数を拒否する', () => {
    const settings = { ...DEFAULT_MAINTENANCE_SETTINGS, review_days: { ...DEFAULT_MAINTENANCE_SETTINGS.review_days, project: 30 } };
    expect(reviewSchedule('project', '2026-01-01T00:00:00.000Z', settings).next_review_at)
      .toBe('2026-01-31T00:00:00.000Z');
    expect(() => reviewSchedule('project', '2026-01-01T00:00:00.000Z', {
      ...settings, review_days: { ...settings.review_days, project: 0 },
    })).toThrow();
  });
});
