import { afterEach, expect, test, vi } from 'vitest';
import { resolveStorageMode } from '@/lib/storage/contracts';
afterEach(() => vi.unstubAllEnvs());
test('storage selection reads the current environment on every call', () => {
  vi.stubEnv('LTM_STORAGE_DRIVER', undefined);
  expect(resolveStorageMode()).toBe('local');
  vi.stubEnv('LTM_STORAGE_DRIVER', 'vercel');
  expect(resolveStorageMode()).toBe('vercel');
  vi.stubEnv('LTM_STORAGE_DRIVER', 'local');
  expect(resolveStorageMode()).toBe('local');
});
test('invalid storage selection is rejected', () => {
  vi.stubEnv('LTM_STORAGE_DRIVER', 'invalid');
  expect(() => resolveStorageMode()).toThrow('LTM_STORAGE_DRIVER');
});
