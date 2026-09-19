import { authRequired } from './config';
import { getCurrentFirebasePrincipal, getFirebasePrincipal, requireCurrentFirebasePrincipal, requireFirebasePrincipal } from './session';

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

export async function getWebPrincipal(request?: Request): Promise<WebPrincipal | null> {
  if (!authRequired()) return null;
  return request ? getFirebasePrincipal(request, { allowBearer: true }) : getCurrentFirebasePrincipal();
}

export async function requireWebPrincipal(request?: Request): Promise<WebPrincipal> {
  if (!authRequired()) throw new UnauthorizedWebError();
  try {
    return request
      ? await requireFirebasePrincipal(request, { allowBearer: true })
      : await requireCurrentFirebasePrincipal();
  } catch { throw new UnauthorizedWebError(); }
}
