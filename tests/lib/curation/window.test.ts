import { expect, test } from 'vitest';

import { inWindow, parseCurationWindow } from '@/lib/curation/window';

test('uses_utc_half_open_window', () => {
  const window = parseCurationWindow({ mode: 'manual', dry_run: false, from_date: '2026-10-01', to_date: '2026-10-02' }, '2026-10-12T00:00:00.000Z');
  expect(window).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', mode: 'manual', dry_run: false });
  expect(inWindow('2026-10-01T00:00:00.000Z', window)).toBe(true);
  expect(inWindow('2026-10-01T23:59:59.999Z', window)).toBe(true);
  expect(inWindow('2026-10-02T00:00:00.000Z', window)).toBe(false);
});

test('rejects_invalid_or_unpaired_date_inputs', () => {
  const now = '2026-10-12T00:00:00.000Z';
  expect(() => parseCurationWindow({ mode: 'manual', dry_run: true, from_date: '2026-02-30', to_date: '2026-03-01' }, now)).toThrow();
  expect(() => parseCurationWindow({ mode: 'manual', dry_run: true, from_date: '2026-10-01' }, now)).toThrow();
  expect(() => parseCurationWindow({ mode: 'manual', dry_run: true, from_date: '2026-10-02', to_date: '2026-10-02' }, now)).toThrow();
  expect(() => parseCurationWindow({ mode: 'schedule', dry_run: false, from_date: '2026-10-01', to_date: '2026-10-02' }, now)).toThrow();
});
