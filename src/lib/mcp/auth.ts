import { timingSafeEqual } from 'node:crypto';

export function grantsSharedWrite(token: string | null): boolean {
  const expected = process.env.LTM_MAINTENANCE_TOKEN;
  if (!expected || token === null) return false;
  const actualBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}
