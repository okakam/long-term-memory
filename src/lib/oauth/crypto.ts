import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function newOpaqueSecret(prefix: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(prefix)) throw new Error('opaque secret prefix is invalid');
  return prefix + randomBytes(32).toString('base64url');
}

export function hashOpaqueSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function secretPrefix(secret: string): string {
  return secret.slice(0, 12);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}
