import { expect, test } from 'vitest';

import { resolveTelemetryWindow } from '@/lib/telemetry/window';

test('telemetry window は 今日までのJST日境界と前期間を返す', () => {
  const window = resolveTelemetryWindow(7, new Date('2026-09-05T15:30:00.000Z'));
  expect(window.start.toISOString()).toBe('2026-08-30T15:00:00.000Z');
  expect(window.end.toISOString()).toBe('2026-09-06T15:00:00.000Z');
  expect(window.previousStart.toISOString()).toBe('2026-08-23T15:00:00.000Z');
});
