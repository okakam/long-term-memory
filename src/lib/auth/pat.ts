import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { getAuthStore, type AuthStore, type TokenRecord } from './store';

export class UnauthorizedMcpError extends Error {
  readonly status = 401;
  constructor() {
    super('invalid MCP credentials');
    this.name = 'UnauthorizedMcpError';
  }
}

export class TokenNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('MCP token not found');
    this.name = 'TokenNotFoundError';
  }
}

export function hashPat(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function expiryIso(expiresAt: string | Date | undefined): string | null {
  if (expiresAt === undefined) return null;
  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new Error('expiresAt must be a future date');
  }
  return date.toISOString();
}

export async function createPat(
  userId: string,
  label: string,
  expiresAt?: string | Date,
  store?: AuthStore,
): Promise<{ token: string; tokenId: string }> {
  if (!userId || !label.trim()) throw new Error('userId and label are required');
  const token = 'ltm_' + randomBytes(32).toString('base64url');
  const tokenId = randomUUID();
  await (store ?? await getAuthStore()).insertToken({
    id: tokenId,
    user_id: userId,
    token_hash: hashPat(token),
    token_prefix: token.slice(0, 12),
    label: label.trim(),
    audience: 'mcp',
    created_at: new Date().toISOString(),
    last_used_at: null,
    expires_at: expiryIso(expiresAt),
    revoked_at: null,
  });
  return { token, tokenId };
}

function bearerToken(req: Request): string {
  const header = req.headers.get('authorization');
  if (!header) throw new UnauthorizedMcpError();
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match || !match[1].startsWith('ltm_') || match[1].length <= 4) {
    throw new UnauthorizedMcpError();
  }
  return match[1];
}

function usable(record: TokenRecord | null): record is TokenRecord {
  if (!record || record.audience !== 'mcp' || record.revoked_at !== null) return false;
  if (!record.expires_at) return true;
  const expires = Date.parse(record.expires_at);
  return !Number.isNaN(expires) && expires > Date.now();
}

export async function requireMcpPrincipal(
  req: Request,
  store?: AuthStore,
): Promise<{ userId: string; tokenId: string }> {
  const token = bearerToken(req);
  const authStore = store ?? await getAuthStore();
  const record = await authStore.findTokenByHash(hashPat(token));
  if (!usable(record)) throw new UnauthorizedMcpError();
  await authStore.touchToken(record.id);
  return { userId: record.user_id, tokenId: record.id };
}

export async function revokePat(userId: string, tokenId: string, store?: AuthStore): Promise<void> {
  const revoked = await (store ?? await getAuthStore()).revokeToken(userId, tokenId);
  if (!revoked) throw new TokenNotFoundError();
}

export async function listPats(userId: string, store?: AuthStore): Promise<Array<Omit<TokenRecord, 'token_hash'>>> {
  return (store ?? await getAuthStore()).listTokens(userId);
}
