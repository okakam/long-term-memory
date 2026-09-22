import { expect, test } from 'vitest';

import { constantTimeEqual, hashOpaqueSecret, newOpaqueSecret, secretPrefix } from '@/lib/oauth/crypto';

test('opaque secretは毎回異なり、hashとprefixは本文を含まない', () => {
  const first = newOpaqueSecret('ltm_oat_');
  const second = newOpaqueSecret('ltm_oat_');

  expect(first).toMatch(/^ltm_oat_[A-Za-z0-9_-]+$/);
  expect(first).not.toBe(second);
  expect(hashOpaqueSecret(first)).toMatch(/^[a-f0-9]{64}$/);
  expect(hashOpaqueSecret(first)).not.toContain(first);
  expect(secretPrefix(first)).toBe(first.slice(0, 12));
  expect(constantTimeEqual(first, first)).toBe(true);
  expect(constantTimeEqual(first, second)).toBe(false);
  expect(constantTimeEqual(first, first.slice(0, -1))).toBe(false);
});
