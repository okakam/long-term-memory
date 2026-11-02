import { resolveStorageMode } from '@/lib/storage/contracts';

import { createFirestoreTelemetryStore } from './firestore-store';

export type TelemetryKind = 'read' | 'write' | 'meta';
export type TelemetryEventName = 'tool_call' | 'connect';
export type TelemetryErrorCode = 'not_found' | 'conflict' | 'validation' | 'internal';

export interface TelemetryRow {
  id: number;
  ts: string;
  event: TelemetryEventName;
  project_id: string;
  session_id: string | null;
  /** Firebase UID. Set only on events without a project; absent on older documents. */
  user_id?: string | null;
  tool: string | null;
  kind: TelemetryKind | null;
  ok: number;
  error_code: TelemetryErrorCode | null;
  duration_ms: number;
  result_count: number | null;
  result_chars: number | null;
  maintenance: number;
}

export interface ToolCallEvent {
  ts?: string;
  projectId: string;
  sessionId?: string | null;
  userId?: string | null;
  tool: string;
  kind: TelemetryKind;
  ok: boolean;
  errorCode?: TelemetryErrorCode | null;
  durationMs: number;
  resultCount?: number | null;
  resultChars?: number | null;
  maintenance?: boolean;
}

export interface ConnectEvent {
  ts?: string;
  projectId: string;
  sessionId: string;
  userId?: string | null;
}

export interface TelemetryStoreLike {
  recordToolCall(event: ToolCallEvent): void | Promise<void>;
  recordConnect(event: ConnectEvent): void | Promise<void>;
  rows(options?: { from?: Date; to?: Date; projectId?: string }): TelemetryRow[] | Promise<TelemetryRow[]>;
  close(): void | Promise<void>;
}

/** Process-local telemetry for local development and tests. Cloud mode uses FirestoreTelemetryStore. */
export class TelemetryStore implements TelemetryStoreLike {
  private readonly events: TelemetryRow[] = [];
  private nextId = 1;

  static open(...unused: unknown[]): TelemetryStore {
    void unused;
    return new TelemetryStore();
  }

  static openDefault(): TelemetryStore {
    return new TelemetryStore();
  }

  recordToolCall(event: ToolCallEvent): void {
    this.events.push({
      id: this.nextId++, ts: event.ts ?? new Date().toISOString(), event: 'tool_call',
      project_id: event.projectId, session_id: event.sessionId ?? null, user_id: event.userId ?? null, tool: event.tool, kind: event.kind,
      ok: event.ok ? 1 : 0, error_code: event.errorCode ?? null,
      duration_ms: Math.max(0, Math.floor(event.durationMs)), result_count: event.resultCount ?? null,
      result_chars: event.resultChars ?? null, maintenance: event.maintenance ? 1 : 0,
    });
  }

  recordConnect(event: ConnectEvent): void {
    this.events.push({
      id: this.nextId++, ts: event.ts ?? new Date().toISOString(), event: 'connect',
      project_id: event.projectId, session_id: event.sessionId, user_id: event.userId ?? null, tool: null, kind: null,
      ok: 1, error_code: null, duration_ms: 0, result_count: null, result_chars: null, maintenance: 0,
    });
  }

  rows(options: { from?: Date; to?: Date; projectId?: string } = {}): TelemetryRow[] {
    return this.events.filter((row) => (
      (!options.from || row.ts >= options.from.toISOString())
      && (!options.to || row.ts < options.to.toISOString())
      && (!options.projectId || row.project_id === options.projectId)
    )).map((row) => ({ ...row }));
  }

  close(): void {
    this.events.length = 0;
  }
}

let singleton: TelemetryStoreLike | null = null;
let testStore: TelemetryStoreLike | null = null;

export function getTelemetryStore(): TelemetryStoreLike {
  if (testStore) return testStore;
  if (!singleton) singleton = resolveStorageMode() === 'cloud' ? createFirestoreTelemetryStore() : TelemetryStore.openDefault();
  return singleton;
}

export function setTelemetryStoreForTests(store: TelemetryStoreLike): void {
  testStore = store;
}

export function resetTelemetryStore(): void {
  const current = testStore ?? singleton;
  testStore = null;
  singleton = null;
  if (current) void Promise.resolve(current.close()).catch(() => undefined);
}
