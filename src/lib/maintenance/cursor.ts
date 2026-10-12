import type { MaintenanceEvent } from '@/lib/maintenance/store';

export class MaintenanceCursorError extends Error {
  constructor() {
    super('invalid maintenance cursor');
    this.name = 'MaintenanceCursorError';
  }
}

export interface MaintenanceEventCursor {
  created_at: string;
  operation_id: string;
}

export function encodeMaintenanceEventCursor(event: Pick<MaintenanceEvent, 'created_at' | 'operation_id'>): string {
  return Buffer.from(JSON.stringify([event.created_at, event.operation_id])).toString('base64url');
}

export function decodeMaintenanceEventCursor(value: string): MaintenanceEventCursor {
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string'
      || !Number.isFinite(Date.parse(parsed[0])) || parsed[1].length === 0) throw new Error();
    return { created_at: parsed[0], operation_id: parsed[1] };
  } catch {
    throw new MaintenanceCursorError();
  }
}
