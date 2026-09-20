import { expect, test } from 'vitest';

import { formatJst } from '@/lib/datetime';

test('formatJst は UTC を Asia/Tokyo の固定形式へ変換する', () => {
  expect(formatJst('2026-05-20T06:10:27.105Z')).toBe('2026-05-20 15:10:27');
  expect(formatJst('2026-05-20T15:10:27+09:00')).toBe('2026-05-20 15:10:27');
  expect(formatJst('not-a-date')).toBe('not-a-date');
});
