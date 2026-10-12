import { createHmac, timingSafeEqual } from 'node:crypto';

import type { CurationMemoryCursor, CurationMode, CurationWindow } from './types';

export interface CurationPageToken {
  version: 1;
  view: 'sources' | 'targets';
  project_id: string;
  run_id: string;
  page_index: number;
  stage?: 'deferred' | 'window';
  after: string | null;
  previous_after?: string | null;
  previous_limit?: number;
  previous_hash?: string;
  window?: CurationWindow;
}

function key(): string {
  const value = process.env.LTM_MAINTENANCE_TOKEN;
  if (!value) throw new Error('curation signing key is unavailable');
  return value;
}

function signature(payload: string): Buffer {
  return createHmac('sha256', key()).update(payload, 'utf8').digest();
}

export function signCurationPageToken(token: CurationPageToken): string {
  const payload = Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
  return `${payload}.${signature(payload).toString('base64url')}`;
}

export function readCurationPageToken(value: string): CurationPageToken {
  if (value.length > 4096) throw new Error('invalid curation page token');
  const [payload, encodedSignature, extra] = value.split('.');
  if (!payload || !encodedSignature || extra !== undefined) throw new Error('invalid curation page token');
  const actual = Buffer.from(encodedSignature, 'base64url');
  const expected = signature(payload);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid curation page token');
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) throw new Error();
    const token = value as Partial<CurationPageToken>;
    if (token.version !== 1 || (token.view !== 'sources' && token.view !== 'targets')
      || typeof token.project_id !== 'string' || typeof token.run_id !== 'string'
      || !Number.isSafeInteger(token.page_index) || (token.page_index ?? -1) < 0
      || (token.after !== null && typeof token.after !== 'string')
      || (token.previous_after !== undefined && token.previous_after !== null && typeof token.previous_after !== 'string')
      || (token.previous_limit !== undefined && (!Number.isSafeInteger(token.previous_limit) || token.previous_limit < 1 || token.previous_limit > 25))
      || (token.previous_hash !== undefined && !/^[a-f0-9]{64}$/.test(token.previous_hash))) throw new Error();
    if (token.stage !== undefined && token.stage !== 'deferred' && token.stage !== 'window') throw new Error();
    return token as CurationPageToken;
  } catch {
    throw new Error('invalid curation page token');
  }
}

export function encodeSourceAfter(cursor: CurationMemoryCursor | null): string | null {
  if (cursor === null) return null;
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeSourceAfter(value: string | null): CurationMemoryCursor | null {
  if (value === null) return null;
  if (value.length > 2048) throw new Error('invalid curation memory cursor');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error();
    const cursor = parsed as { created_at?: unknown; id?: unknown };
    if (typeof cursor.created_at !== 'string' || typeof cursor.id !== 'string'
      || !Number.isFinite(Date.parse(cursor.created_at)) || !cursor.id) throw new Error();
    return { created_at: cursor.created_at, id: cursor.id };
  } catch {
    throw new Error('invalid curation memory cursor');
  }
}

export function dailyWindow(mode: CurationMode, from: string | null, to: string, dry_run: boolean): CurationWindow {
  return { from, to, mode, dry_run };
}
