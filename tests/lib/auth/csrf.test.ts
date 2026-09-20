import { expect, test } from 'vitest';

import { assertSameOrigin } from '@/lib/auth/access';

test('mutation request は Origin と Host の同一性を要求する', () => {
  expect(() => assertSameOrigin(new Request('https://example.test/api', { headers: { origin: 'https://example.test', host: 'example.test' } }))).not.toThrow();
  expect(() => assertSameOrigin(new Request('https://example.test/api', { headers: { origin: 'https://evil.example', host: 'example.test' } }))).toThrow(/same-origin/);
  expect(() => assertSameOrigin(new Request('https://example.test/api', { headers: { origin: 'https://example.test', host: 'other.example' } }))).toThrow(/same-origin/);
});
