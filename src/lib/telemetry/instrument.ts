import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { TOOL_CATALOG } from './catalog';
import { recordToolCall } from './recorder';
import type { TelemetryKind } from './store';

export interface InstrumentContext {
  projectId: string;
  sessionId?: string | null;
  maintenance?: boolean;
}

export interface MeasuredResult {
  resultCount: number | null;
  resultChars: number;
}

type RecordToolCall = typeof recordToolCall;
type RegisterTool = (name: string, config: unknown, handler: (input: unknown, extra: unknown) => unknown) => unknown;

function resultText(value: unknown): string {
  if (!value || typeof value !== 'object' || !('content' in value)) return '';
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is { type: 'text'; text: string } => (
      typeof item === 'object' && item !== null
      && (item as { type?: unknown }).type === 'text'
      && typeof (item as { text?: unknown }).text === 'string'
    ))
    .map((item) => item.text)
    .join('');
}

function bestEffortResultCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['nodes', 'memories', 'results', 'projects']) {
    const candidate = (value as Record<string, unknown>)[key];
    if (Array.isArray(candidate)) return candidate.length;
  }
  const text = resultText(value);
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return bestEffortResultCount(parsed);
  } catch {
    return null;
  }
}

export function measure(value: unknown): MeasuredResult {
  const text = resultText(value);
  return {
    resultCount: bestEffortResultCount(value),
    resultChars: [...text].length,
  };
}

function toolKind(name: string, fallback?: TelemetryKind): TelemetryKind {
  return TOOL_CATALOG.find((item) => item.tool === name)?.kind ?? fallback ?? 'meta';
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

/**
 * Wrap McpServer.registerTool so every protocol tool invocation is measured.
 * The wrapper records only aggregate fields; input arguments and response bodies
 * are never passed to the recorder.
 */
export function instrumentRegistrar(
  server: McpServer,
  kind?: TelemetryKind,
  record: RecordToolCall = recordToolCall,
  ctx: InstrumentContext = { projectId: '__unknown__' },
): () => void {
  const original = server.registerTool.bind(server) as RegisterTool;
  const wrapped = ((name: string, config: unknown, handler: (input: unknown, extra: unknown) => unknown) => (
    original(
      name,
      config,
      async (input: unknown, extra: unknown) => {
        const started = performance.now();
        try {
          const value = await handler(input, extra);
          const measured = measure(value);
          await record({
            projectId: ctx.projectId,
            sessionId: ctx.sessionId,
            tool: name,
            kind: toolKind(name, kind),
            ok: true,
            durationMs: elapsedMs(started),
            resultCount: measured.resultCount,
            resultChars: measured.resultChars,
            maintenance: ctx.maintenance ?? false,
          });
          return value;
        } catch (error) {
          await record({
            projectId: ctx.projectId,
            sessionId: ctx.sessionId,
            tool: name,
            kind: toolKind(name, kind),
            ok: false,
            durationMs: elapsedMs(started),
            resultCount: null,
            resultChars: 0,
            maintenance: ctx.maintenance ?? false,
            error,
          });
          throw error;
        }
      },
    )
  )) as RegisterTool;
  server.registerTool = wrapped as typeof server.registerTool;
  return () => {
    server.registerTool = original as typeof server.registerTool;
  };
}
