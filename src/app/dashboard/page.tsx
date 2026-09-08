import Link from 'next/link';

import { Bar } from '@/components/dashboard/Bar';
import { Delta } from '@/components/dashboard/Delta';
import { Sparkline } from '@/components/dashboard/Sparkline';
import { assertProjectAccess } from '@/lib/auth/access';
import { authRequired } from '@/lib/auth/config';
import { requireWebPrincipal } from '@/lib/auth/clerk';
import { getAuthStore } from '@/lib/auth/store';
import { formatJst } from '@/lib/datetime';
import { curatorStatus, dailySeries, errorBreakdown, perProject, perTool, summarize } from '@/lib/telemetry/query';
import { getTelemetryStore, type TelemetryRow } from '@/lib/telemetry/store';
import { resolveTelemetryWindow } from '@/lib/telemetry/window';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseDays(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(365, Math.max(1, Math.floor(parsed))) : 30;
}

function filterRows(rows: TelemetryRow[], projectIds: Set<string> | undefined): TelemetryRow[] {
  return projectIds ? rows.filter((row) => projectIds.has(row.project_id)) : rows;
}

function inRange(row: TelemetryRow, from: Date, to: Date): boolean {
  const timestamp = Date.parse(row.ts);
  return timestamp >= from.getTime() && timestamp < to.getTime();
}

function displayDay(date: string): string {
  return formatJst(date + 'T00:00:00+09:00').slice(0, 10);
}

function displayIso(value: string | null): string {
  return value ? formatJst(value) : '—';
}

function queryLink(days: number, project: string | undefined): string {
  const params = new URLSearchParams({ days: String(days) });
  if (project) params.set('project', project);
  return '/dashboard?' + params.toString();
}

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const requestedProject = first(params.project);
  const days = parseDays(first(params.days));

  let projectIds: Set<string> | undefined;
  if (authRequired()) {
    const principal = await requireWebPrincipal();
    if (requestedProject) {
      await assertProjectAccess(principal, requestedProject, 'read');
      projectIds = new Set([requestedProject]);
    } else {
      const accessible = await (await getAuthStore()).listAccessibleProjects(principal.userId);
      projectIds = new Set([...accessible.map((project) => project.project_id), '__shared__']);
    }
  } else if (requestedProject) {
    projectIds = new Set([requestedProject]);
  }

  const store = getTelemetryStore();
  const allVisibleRows = filterRows(await Promise.resolve(store.rows()), projectIds);
  const window = resolveTelemetryWindow(days);
  const currentRows = allVisibleRows.filter((row) => inRange(row, window.start, window.end));
  const previousRows = allVisibleRows.filter((row) => inRange(row, window.previousStart, window.previousEnd));
  const summary = summarize(currentRows, allVisibleRows);
  const previous = summarize(previousRows, allVisibleRows);
  const series = dailySeries(currentRows, window);
  const tools = perTool(currentRows);
  const projects = perProject(currentRows);
  const errors = errorBreakdown(currentRows);
  const curator = curatorStatus(allVisibleRows);
  const projectFacts = tools.find((tool) => tool.tool === 'remember_project_fact')?.calls ?? 0;
  const sessionSummaries = tools.find((tool) => tool.tool === 'remember_session_summary')?.calls ?? 0;
  const maxDailyCalls = Math.max(1, ...series.map((item) => item.reads + item.writes + item.meta));

  const cards = [
    ['呼び出し', summary.calls, previous.calls],
    ['read', summary.reads, previous.reads],
    ['write', summary.writes, previous.writes],
    ['meta', summary.meta, previous.meta],
    ['connect', summary.connects, previous.connects],
    ['エラー', summary.errors, previous.errors],
  ] as const;

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '2rem 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <header>
        <p><Link href="/">長期記憶</Link> / usage dashboard</p>
        <h1>利用量ダッシュボード</h1>
        <p>{displayIso(window.start.toISOString())} — {displayIso(window.end.toISOString())}（JST・{days}日）{requestedProject ? ' / project: ' + requestedProject : ''}</p>
        <nav aria-label="期間">
          {[7, 30, 90].map((preset) => <a key={preset} href={queryLink(preset, requestedProject)} style={{ marginRight: 12 }}>{preset}日</a>)}
        </nav>
      </header>

      <section aria-labelledby="summary-heading">
        <h2 id="summary-heading">概要</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
          {cards.map(([label, value, oldValue]) => (
            <article key={label} style={{ border: '1px solid #ddd', padding: 12 }}>
              <strong>{label}</strong><div style={{ fontSize: 28 }}>{value}</div>
              <Delta current={value} previous={oldValue} />
            </article>
          ))}
        </div>
        <p>エラー率: {(summary.errorRate * 100).toFixed(1)}% / calls per connect: {summary.callsPerConnect.toFixed(2)}</p>
        <p>readless connection: {(summary.readlessRate * 100).toFixed(1)}%（{summary.connectionsWithRead}/{summary.connectionsTracked}）</p>
      </section>

      <section aria-labelledby="daily-heading">
        <h2 id="daily-heading">日次推移</h2>
        <div style={{ display: 'grid', gap: 8 }}>
          {series.map((day) => (
            <div key={day.date} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 90px', alignItems: 'center', gap: 8 }}>
              <time dateTime={day.date}>{displayDay(day.date)}</time>
              <Bar value={day.reads + day.writes + day.meta} max={maxDailyCalls} label={day.date + ' calls'} />
              <Sparkline values={[day.reads, day.writes, day.meta]} />
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="alerts-heading">
        <h2 id="alerts-heading">アラート</h2>
        <ul>
          {summary.r1Suppressed
            ? <li>R1: 未帰属呼び出しが多いため readless 判定を抑制中</li>
            : <li>R1: {summary.readlessRate > 0.5 ? 'readless connection が 50% 超' : '正常'}</li>}
          <li>R4: {projectFacts > sessionSummaries ? 'remember_project_fact が session summary を上回っています' : '正常'}</li>
          <li>R6: {curator.stale ? 'curator が stale（最終成功: ' + displayIso(curator.lastWriteIso) + '）' : '正常（最終成功: ' + displayIso(curator.lastWriteIso) + '）'}</li>
        </ul>
      </section>

      <section aria-labelledby="tools-heading">
        <h2 id="tools-heading">ツール別</h2>
        <table>
          <thead><tr><th>tool</th><th>kind</th><th>calls</th><th>error rate</th><th>zero results</th><th>result chars p95</th><th>last used</th></tr></thead>
          <tbody>{tools.map((tool) => (
            <tr key={tool.tool}>
              <td>{tool.tool}</td><td>{tool.kind}</td><td>{tool.calls}</td>
              <td>{(tool.errorRate * 100).toFixed(1)}%</td><td>{(tool.zeroResultsRate * 100).toFixed(1)}%</td>
              <td>{tool.result_chars_p95}</td><td>{displayIso(tool.lastUsedAt)}</td>
            </tr>
          ))}</tbody>
        </table>
      </section>

      <section aria-labelledby="projects-heading">
        <h2 id="projects-heading">プロジェクト別</h2>
        <table>
          <thead><tr><th>project</th><th>calls</th><th>connects</th><th>errors</th><th>maintenance writes</th></tr></thead>
          <tbody>{projects.map((project) => (
            <tr key={project.project_id}><td>{project.project_id}</td><td>{project.calls}</td><td>{project.connects}</td><td>{project.errors}</td><td>{project.maintenanceWrites}</td></tr>
          ))}</tbody>
        </table>
      </section>

      <section aria-labelledby="errors-heading">
        <h2 id="errors-heading">エラー内訳</h2>
        {errors.length === 0 ? <p>エラーなし</p> : <ul>{errors.map((error) => <li key={error.error_code + '-' + error.tool}>{error.error_code} / {error.tool}: {error.calls}</li>)}</ul>}
      </section>

      <p>maintenance writes: {series.reduce((total, day) => total + day.maintenanceWrites, 0)}</p>
    </main>
  );
}
