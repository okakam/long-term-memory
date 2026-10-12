import type { CurationWindow, CurationMode } from './types';

export interface CurationWindowInput {
  mode: CurationMode;
  dry_run: boolean;
  from_date?: string;
  to_date?: string;
}

function validIso(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function dateBoundary(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('curation date must use UTC YYYY-MM-DD');
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error('curation date is invalid');
  }
  return new Date(timestamp).toISOString();
}

export function parseCurationWindow(input: CurationWindowInput, now: string): CurationWindow {
  if (!validIso(now)) throw new Error('curation run time must be a canonical UTC timestamp');
  const hasFrom = input.from_date !== undefined;
  const hasTo = input.to_date !== undefined;
  if (hasFrom !== hasTo) throw new Error('from_date and to_date must be provided together');
  if (input.mode === 'schedule' && (hasFrom || hasTo)) throw new Error('scheduled curation cannot specify dates');
  if (!hasFrom) return { from: null, to: now, mode: input.mode, dry_run: input.dry_run };
  const from = dateBoundary(input.from_date!);
  const to = dateBoundary(input.to_date!);
  if (from >= to) throw new Error('curation from_date must be earlier than to_date');
  return { from, to, mode: input.mode, dry_run: input.dry_run };
}

export function inWindow(createdAt: string, window: Pick<CurationWindow, 'from' | 'to'>): boolean {
  const value = Date.parse(createdAt);
  const from = window.from === null ? Number.NEGATIVE_INFINITY : Date.parse(window.from);
  const to = Date.parse(window.to);
  return Number.isFinite(value) && Number.isFinite(to) && value >= from && value < to;
}

export interface MemoryPageCursor {
  created_at: string;
  id: string;
}

export function encodeMemoryPageCursor(cursor: MemoryPageCursor): string {
  if (!validIso(cursor.created_at) || !cursor.id) throw new Error('invalid memory page cursor');
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeMemoryPageCursor(value: string): MemoryPageCursor {
  if (value.length > 2048) throw new Error('invalid memory page cursor');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('created_at' in parsed) || !('id' in parsed)) throw new Error();
    const cursor = parsed as { created_at?: unknown; id?: unknown };
    if (typeof cursor.created_at !== 'string' || typeof cursor.id !== 'string'
      || !validIso(cursor.created_at) || cursor.id.length === 0) throw new Error();
    return { created_at: cursor.created_at, id: cursor.id };
  } catch {
    throw new Error('invalid memory page cursor');
  }
}
