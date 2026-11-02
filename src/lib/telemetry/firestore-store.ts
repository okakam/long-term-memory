import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import { getFirebaseAdminApp } from '@/lib/auth/firebase';

import type { ConnectEvent, TelemetryRow, TelemetryStoreLike, ToolCallEvent } from './store';

export const TELEMETRY_COLLECTION = 'telemetryEvents';
/** Covers the longest dashboard window (365 days). Firestore TTL deletes expired events. */
export const TELEMETRY_RETENTION_DAYS = 400;
const WRITE_TIMEOUT_MS = 2_000;

type TelemetryDocument = Omit<TelemetryRow, 'id'> & { expires_at: Date };

export interface TelemetryEventsBackend {
  add(data: TelemetryDocument): Promise<void>;
  list(options: { from?: Date; to?: Date }): Promise<Record<string, unknown>[]>;
}

function adminBackend(firestore: Firestore): TelemetryEventsBackend {
  const collection = firestore.collection(TELEMETRY_COLLECTION);
  return {
    add: async (data) => { await collection.add(data); },
    list: async ({ from, to }) => {
      let query = collection.orderBy('ts', 'asc');
      if (from) query = query.where('ts', '>=', from.toISOString());
      if (to) query = query.where('ts', '<', to.toISOString());
      return (await query.get()).docs.map((document) => document.data());
    },
  };
}

function expiresAt(ts: string): Date {
  return new Date(Date.parse(ts) + TELEMETRY_RETENTION_DAYS * 86_400_000);
}

/**
 * Durable, best-effort telemetry. A failed or slow write must never fail the MCP
 * call being measured, so writes time out and only log. Only aggregate fields are
 * stored; memory bodies and tool inputs never reach this store.
 */
export class FirestoreTelemetryStore implements TelemetryStoreLike {
  constructor(private readonly backend: TelemetryEventsBackend) {}

  async recordToolCall(event: ToolCallEvent): Promise<void> {
    const ts = event.ts ?? new Date().toISOString();
    await this.write({
      ts, event: 'tool_call', project_id: event.projectId, session_id: event.sessionId ?? null, user_id: event.userId ?? null,
      tool: event.tool, kind: event.kind, ok: event.ok ? 1 : 0, error_code: event.errorCode ?? null,
      duration_ms: Math.max(0, Math.floor(event.durationMs)), result_count: event.resultCount ?? null,
      result_chars: event.resultChars ?? null, maintenance: event.maintenance ? 1 : 0,
      expires_at: expiresAt(ts),
    });
  }

  async recordConnect(event: ConnectEvent): Promise<void> {
    const ts = event.ts ?? new Date().toISOString();
    await this.write({
      ts, event: 'connect', project_id: event.projectId, session_id: event.sessionId, user_id: event.userId ?? null,
      tool: null, kind: null, ok: 1, error_code: null, duration_ms: 0,
      result_count: null, result_chars: null, maintenance: 0, expires_at: expiresAt(ts),
    });
  }

  async rows(options: { from?: Date; to?: Date; projectId?: string } = {}): Promise<TelemetryRow[]> {
    const documents = await this.backend.list({ from: options.from, to: options.to });
    return documents
      .filter((document) => !options.projectId || document.project_id === options.projectId)
      .map((document, index) => {
        const { expires_at: _expiresAt, ...row } = document;
        void _expiresAt;
        return { ...row, id: index + 1 } as TelemetryRow;
      });
  }

  close(): void {}

  private async write(data: TelemetryDocument): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.backend.add(data),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), WRITE_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      console.warn(`telemetry write failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createFirestoreTelemetryStore(firestore: Firestore = getFirestore(getFirebaseAdminApp())): FirestoreTelemetryStore {
  return new FirestoreTelemetryStore(adminBackend(firestore));
}
