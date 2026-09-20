import { expect, test } from 'vitest';

import { resolveTelemetryWindow } from '@/lib/telemetry/window';

test('telemetry window は JST 日境界と前期間を返す', () => {
  const window = resolveTelemetryWindow(7, new Date('2026-09-05T15:30:00.000Z'));
  expect(window.start.toISOString()).toBe('2026-09-05T15:00:00.000Z');
  expect(window.end.toISOString()).toBe('2026-09-12T15:00:00.000Z');
  expect(window.previousStart.toISOString()).toBe('2026-08-29T15:00:00.000Z');
});
