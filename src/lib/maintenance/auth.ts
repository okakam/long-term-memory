import { timingSafeEqual } from 'node:crypto';

import { UnauthorizedMcpError } from '@/lib/auth/pat';

export interface AutomationCredential {
  kind: 'maintenance';
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get('authorization');
  const match = value ? /^Bearer\s+(\S+)$/i.exec(value.trim()) : null;
  return match?.[1] ?? null;
}

export async function requireAutomationCredential(request: Request): Promise<AutomationCredential> {
  const expected = process.env.LTM_AUTO_MAINTENANCE_TOKEN;
  const actual = bearerToken(request);
  if (!expected || !actual) throw new UnauthorizedMcpError();
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual, 'utf8');
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
    throw new UnauthorizedMcpError();
  }
  return { kind: 'maintenance' };
}
