import { authRequired } from './config';
import { getCurrentFirebasePrincipal, requireCurrentFirebasePrincipal } from './session';

export interface WebPrincipal {
  userId: string;
}

export class UnauthorizedWebError extends Error {
  readonly status = 401;
  constructor() {
    super('authentication required');
    this.name = 'UnauthorizedWebError';
  }
}

export async function getWebPrincipal(): Promise<WebPrincipal | null> {
  if (!authRequired()) return null;
  return getCurrentFirebasePrincipal();
}

export async function requireWebPrincipal(): Promise<WebPrincipal> {
  if (!authRequired()) throw new UnauthorizedWebError();
  try { return await requireCurrentFirebasePrincipal(); } catch { throw new UnauthorizedWebError(); }
}
