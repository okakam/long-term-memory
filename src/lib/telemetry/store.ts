import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createClient, type Client } from '@libsql/client';

import { resolveStorage } from '@/lib/paths';
import { resolveStorageMode } from '@/lib/storage/contracts';
import type { SqlValue } from '@/lib/storage/contracts';
import { TursoIndexStore } from '@/lib/storage/turso-index';
import { migrateTelemetry } from './migrate';

export type TelemetryKind = 'read' | 'write' | 'meta';
export type TelemetryEventName = 'tool_call' | 'connect';
export type TelemetryErrorCode = 'not_found' | 'conflict' | 'validation' | 'internal';

export interface TelemetryRow {
  id: number;
  ts: string;
  event: TelemetryEventName;
  project_id: string;
  session_id: string | null;
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
}

export interface TelemetryStoreLike {
  recordToolCall(event: ToolCallEvent): void | Promise<void>;
  recordConnect(event: ConnectEvent): void | Promise<void>;
  rows(options?: { from?: Date; to?: Date; projectId?: string }): TelemetryRow[] | Promise<TelemetryRow[]>;
  close(): void | Promise<void>;
}

function rowsQuery(options: { from?: Date; to?: Date; projectId?: string } = {}): { sql: string; args: SqlValue[] } {
  const params: SqlValue[] = [];
  const where: string[] = [];
  if (options.from) { where.push('ts >= ?'); params.push(options.from.toISOString()); }
  if (options.to) { where.push('ts < ?'); params.push(options.to.toISOString()); }
  if (options.projectId) { where.push('project_id = ?'); params.push(options.projectId); }
  const sql = 'SELECT id, ts, event, project_id, session_id, tool, kind, ok, error_code, duration_ms, result_count, result_chars, maintenance FROM tool_events'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY ts ASC, id ASC';
  return { sql, args: params };
}

function recordToolSql(event: ToolCallEvent): { sql: string; args: SqlValue[] } {
  return {
    sql: 'INSERT INTO tool_events '
      + '(ts, event, project_id, session_id, tool, kind, ok, error_code, duration_ms, result_count, result_chars, maintenance) '
      + "VALUES (?, 'tool_call', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [
      event.ts ?? new Date().toISOString(), event.projectId, event.sessionId ?? null, event.tool,
      event.kind, event.ok ? 1 : 0, event.errorCode ?? null, Math.max(0, Math.floor(event.durationMs)),
      event.resultCount ?? null, event.resultChars ?? null, event.maintenance ? 1 : 0,
    ],
  };
}

function recordConnectSql(event: ConnectEvent): { sql: string; args: SqlValue[] } {
  return {
    sql: 'INSERT INTO tool_events '
      + '(ts, event, project_id, session_id, tool, kind, ok, error_code, duration_ms, result_count, result_chars, maintenance) '
      + "VALUES (?, 'connect', ?, ?, NULL, NULL, 1, NULL, 0, NULL, NULL, 0)",
    args: [event.ts ?? new Date().toISOString(), event.projectId, event.sessionId],
  };
}

export class TelemetryStore {
  private constructor(private readonly db: Database.Database) {}

  static open(db: Database.Database): TelemetryStore {
    migrateTelemetry(db);
    return new TelemetryStore(db);
  }

  static openDefault(): TelemetryStore {
    const path = join(resolveStorage().home, 'telemetry.db');
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    try {
      db.pragma('journal_mode = WAL');
      migrateTelemetry(db);
      return new TelemetryStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  recordToolCall(event: ToolCallEvent): void {
    const query = recordToolSql(event);
    this.db.prepare(query.sql).run(...query.args);
  }

  recordConnect(event: ConnectEvent): void {
    const query = recordConnectSql(event);
    this.db.prepare(query.sql).run(...query.args);
  }

  rows(options: { from?: Date; to?: Date; projectId?: string } = {}): TelemetryRow[] {
    const query = rowsQuery(options);
    return this.db.prepare(query.sql).all(...query.args) as TelemetryRow[];
  }

  withDb<T>(fn: (db: Database.Database) => T): T {
    return fn(this.db);
  }

  close(): void {
    this.db.close();
  }
}

export interface TursoTelemetryOptions {
  client?: Client;
  url?: string;
  authToken?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

export class TursoTelemetryStore implements TelemetryStoreLike {
  private readonly ready: Promise<TursoIndexStore>;

  constructor(options: TursoTelemetryOptions = {}) {
    const client = options.client ?? createClient({
      url: options.url ?? requiredEnv('TURSO_TELEMETRY_DATABASE_URL'),
      authToken: options.authToken ?? requiredEnv('TURSO_TELEMETRY_AUTH_TOKEN'),
    });
    const store = new TursoIndexStore(client, client);
    this.ready = migrateTelemetry(store).then(() => store).catch((error) => {
      store.close();
      throw error;
    });
  }

  static async open(options: TursoTelemetryOptions = {}): Promise<TursoTelemetryStore> {
    const store = new TursoTelemetryStore(options);
    await store.ready;
    return store;
  }

  async recordToolCall(event: ToolCallEvent): Promise<void> {
    const query = recordToolSql(event);
    await (await this.ready).exec(query.sql, query.args);
  }

  async recordConnect(event: ConnectEvent): Promise<void> {
    const query = recordConnectSql(event);
    await (await this.ready).exec(query.sql, query.args);
  }

  async rows(options: { from?: Date; to?: Date; projectId?: string } = {}): Promise<TelemetryRow[]> {
    const query = rowsQuery(options);
    return (await this.ready).query<TelemetryRow>(query.sql, query.args);
  }

  async close(): Promise<void> {
    const store = await this.ready.catch(() => null);
    store?.close();
  }
}

let singleton: TelemetryStoreLike | null = null;
let testStore: TelemetryStoreLike | null = null;

function defaultMode(): 'local' | 'vercel' {
  return process.env.LTM_STORAGE_DRIVER
    ? resolveStorageMode()
    : (process.env.VERCEL === '1' ? 'vercel' : 'local');
}

export function getTelemetryStore(): TelemetryStoreLike {
  if (testStore) return testStore;
  if (!singleton) {
    singleton = defaultMode() === 'vercel'
      ? new TursoTelemetryStore()
      : TelemetryStore.openDefault();
  }
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
