import { getTelemetryStore, type TelemetryErrorCode, type ToolCallEvent, type ConnectEvent } from './store';
import { latestConnection, registerConnection } from './connection';

let brokenStore = false;
let warned = false;

export function telemetryEnabled(): boolean {
  return process.env.LTM_TELEMETRY !== '0' && !brokenStore;
}

function disableTelemetry(): void {
  brokenStore = true;
  if (!warned) {
    warned = true;
    console.warn('telemetry disabled after storage failure');
  }
}

export function errorCode(error: unknown): TelemetryErrorCode {
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (name.includes('notfound') || name.includes('not_found') || message.includes('not found')) return 'not_found';
  if (name.includes('conflict') || message.includes('already exists')) return 'conflict';
  if (name.includes('zod') || name.includes('validation') || message.includes('invalid') || message.includes('slug')) return 'validation';
  return 'internal';
}

export async function recordToolCall(event: Omit<ToolCallEvent, 'sessionId' | 'errorCode'> & { sessionId?: string | null; error?: unknown; errorCode?: TelemetryErrorCode | null }): Promise<void> {
  if (!telemetryEnabled()) return;
  try {
    const { error, ...fields } = event;
    await getTelemetryStore().recordToolCall({
      ...fields,
      sessionId: event.sessionId ?? latestConnection(event.projectId),
      errorCode: event.errorCode ?? (error ? errorCode(error) : null),
    });
  } catch (error) {
    void error;
    disableTelemetry();
  }
}

export async function recordConnect(event: ConnectEvent): Promise<void> {
  if (!telemetryEnabled()) return;
  try {
    const sessionId = registerConnection(event.projectId, event.sessionId);
    await getTelemetryStore().recordConnect({ ...event, sessionId });
  } catch (error) {
    void error;
    disableTelemetry();
  }
}

export function resetRecorderState(): void {
  brokenStore = false;
  warned = false;
}
