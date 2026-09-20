import { TOOL_CATALOG } from './catalog';
import type { TelemetryRow } from './store';
import type { TelemetryWindow } from './window';

const JST = 'Asia/Tokyo';
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: JST, year: 'numeric', month: '2-digit', day: '2-digit',
});

function dayKey(ts: string | Date): string {
  return dayFormatter.format(typeof ts === 'string' ? new Date(ts) : ts).replaceAll('/', '-');
}

function calls(rows: TelemetryRow[]): TelemetryRow[] {
  return rows.filter((row) => row.event === 'tool_call');
}

export interface TelemetrySummary {
  calls: number;
  reads: number;
  writes: number;
  meta: number;
  connects: number;
  errors: number;
  errorRate: number;
  connectionsTracked: number;
  connectionsWithRead: number;
  readlessRate: number;
  callsPerConnect: number;
  unattributedCalls: number;
  r1Suppressed: boolean;
}

export function summarize(rows: TelemetryRow[], attributionRows = rows): TelemetrySummary {
  const toolCalls = calls(rows);
  const reads = toolCalls.filter((row) => row.kind === 'read').length;
  const writes = toolCalls.filter((row) => row.kind === 'write').length;
  const meta = toolCalls.filter((row) => row.kind === 'meta').length;
  const errors = toolCalls.filter((row) => row.ok === 0).length;
  const sessions = new Set(rows.filter((row) => row.event === 'connect' && row.session_id).map((row) => row.session_id!));
  const readSessions = new Set(calls(attributionRows).filter((row) => row.kind === 'read' && row.session_id).map((row) => row.session_id!));
  const connectionsWithRead = [...sessions].filter((session) => readSessions.has(session)).length;
  const unattributedCalls = toolCalls.filter((row) => row.session_id === null).length;
  const readless = sessions.size === 0 ? 0 : (sessions.size - connectionsWithRead) / sessions.size;
  const rate = toolCalls.length === 0 ? 0 : errors / toolCalls.length;
  return {
    calls: toolCalls.length,
    reads, writes, meta,
    connects: rows.filter((row) => row.event === 'connect').length,
    errors,
    errorRate: rate,
    connectionsTracked: sessions.size,
    connectionsWithRead,
    readlessRate: readless,
    callsPerConnect: rows.filter((row) => row.event === 'connect').length === 0
      ? 0 : toolCalls.length / rows.filter((row) => row.event === 'connect').length,
    unattributedCalls,
    r1Suppressed: toolCalls.length > 0 && unattributedCalls / toolCalls.length > 0.1,
  };
}

export interface DailyMetric {
  date: string;
  reads: number;
  writes: number;
  meta: number;
  connects: number;
  errors: number;
  maintenanceWrites: number;
}

export function dailySeries(rows: TelemetryRow[], window: TelemetryWindow): DailyMetric[] {
  const result = Array.from({ length: window.days }, (_, index) => {
    const date = dayKey(new Date(window.start.getTime() + index * 86_400_000));
    return { date, reads: 0, writes: 0, meta: 0, connects: 0, errors: 0, maintenanceWrites: 0 };
  });
  const byDate = new Map(result.map((item) => [item.date, item]));
  for (const row of rows) {
    const date = dayKey(row.ts);
    const item = byDate.get(date);
    if (!item) continue;
    if (row.event === 'connect') { item.connects += 1; continue; }
    if (row.kind === 'read') item.reads += 1;
    if (row.kind === 'write') {
      item.writes += 1;
      if (row.maintenance === 1) item.maintenanceWrites += 1;
    }
    if (row.kind === 'meta') item.meta += 1;
    if (row.ok === 0) item.errors += 1;
  }
  return result;
}

export interface ToolMetric {
  tool: string;
  kind: string;
  calls: number;
  errors: number;
  errorRate: number;
  zeroResults: number;
  zeroResultsRate: number;
  result_chars_p95: number;
  lastUsedAt: string | null;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)];
}

export function perTool(rows: TelemetryRow[]): ToolMetric[] {
  const toolCalls = calls(rows);
  return TOOL_CATALOG.map(({ tool, kind }) => {
    const matching = toolCalls.filter((row) => row.tool === tool);
    const errors = matching.filter((row) => row.ok === 0).length;
    const resultValues = matching.map((row) => row.result_chars).filter((value): value is number => value !== null);
    const last = matching.length ? matching.reduce((latest, row) => row.ts > latest ? row.ts : latest, matching[0].ts) : null;
    return {
      tool, kind, calls: matching.length, errors,
      errorRate: matching.length ? errors / matching.length : 0,
      zeroResults: matching.filter((row) => row.result_count === 0).length,
      zeroResultsRate: matching.length ? matching.filter((row) => row.result_count === 0).length / matching.length : 0,
      result_chars_p95: percentile(resultValues, 0.95),
      lastUsedAt: last,
    };
  });
}

export interface ProjectMetric {
  project_id: string;
  calls: number;
  connects: number;
  errors: number;
  maintenanceWrites: number;
}

export function perProject(rows: TelemetryRow[]): ProjectMetric[] {
  const projects = new Map<string, ProjectMetric>();
  for (const row of rows) {
    const item = projects.get(row.project_id) ?? { project_id: row.project_id, calls: 0, connects: 0, errors: 0, maintenanceWrites: 0 };
    if (row.event === 'connect') item.connects += 1;
    else {
      item.calls += 1;
      if (row.ok === 0) item.errors += 1;
      if (row.kind === 'write' && row.maintenance === 1) item.maintenanceWrites += 1;
    }
    projects.set(row.project_id, item);
  }
  return [...projects.values()].sort((a, b) => a.project_id.localeCompare(b.project_id));
}

export interface ErrorMetric {
  error_code: string;
  tool: string;
  calls: number;
}

export function errorBreakdown(rows: TelemetryRow[]): ErrorMetric[] {
  const counts = new Map<string, ErrorMetric>();
  for (const row of calls(rows)) {
    if (row.ok === 1 || !row.error_code || !row.tool) continue;
    const key = row.error_code + '\0' + row.tool;
    const item = counts.get(key) ?? { error_code: row.error_code, tool: row.tool, calls: 0 };
    item.calls += 1;
    counts.set(key, item);
  }
  return [...counts.values()].sort((a, b) => b.calls - a.calls || a.error_code.localeCompare(b.error_code));
}

export interface CuratorMetric {
  lastWriteIso: string | null;
  stale: boolean;
  ageDays: number | null;
}

export function curatorStatus(rows: TelemetryRow[], now = new Date(), staleDays = 2): CuratorMetric {
  const writes = calls(rows).filter((row) => row.kind === 'write' && row.maintenance === 1 && row.ok === 1);
  const lastWriteIso = writes.length ? writes.reduce((latest, row) => row.ts > latest ? row.ts : latest, writes[0].ts) : null;
  if (!lastWriteIso) return { lastWriteIso: null, stale: true, ageDays: null };
  const ageDays = Math.max(0, (now.getTime() - Date.parse(lastWriteIso)) / 86_400_000);
  return { lastWriteIso, stale: ageDays >= staleDays, ageDays };
}
