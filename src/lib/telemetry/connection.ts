import { randomUUID } from 'node:crypto';

const latest = new Map<string, string>();

export function registerConnection(projectId: string, sessionId: string = randomUUID()): string {
  latest.set(projectId, sessionId);
  return sessionId;
}

export function latestConnection(projectId: string): string | null {
  return latest.get(projectId) ?? null;
}

export function resetConnectionRegistry(): void {
  latest.clear();
}
