import { afterEach, expect, test } from 'vitest';

import { grantsSharedWrite } from '@/lib/mcp/auth';

const original = process.env.LTM_MAINTENANCE_TOKEN;
afterEach(() => { if (original === undefined) delete process.env.LTM_MAINTENANCE_TOKEN; else process.env.LTM_MAINTENANCE_TOKEN = original; });

test('共有書き込みは env と token の完全一致だけを許可する', () => {
  delete process.env.LTM_MAINTENANCE_TOKEN;
  expect(grantsSharedWrite(null)).toBe(false);
  process.env.LTM_MAINTENANCE_TOKEN = 'secret';
  expect(grantsSharedWrite(null)).toBe(false);
  expect(grantsSharedWrite('secret')).toBe(true);
  expect(grantsSharedWrite('secret-extra')).toBe(false);
});
