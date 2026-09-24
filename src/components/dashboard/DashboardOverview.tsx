import { Bar } from '@/components/dashboard/Bar';
import { Delta } from '@/components/dashboard/Delta';
import { Sparkline } from '@/components/dashboard/Sparkline';
import { ProjectManagementPanel, type AccessibleProject } from '@/components/project-management/ProjectManagementPanel';
import type {
  CuratorMetric,
  DailyMetric,
  ErrorMetric,
  ProjectMetric,
  TelemetrySummary,
  ToolMetric,
} from '@/lib/telemetry/query';

interface DashboardOverviewProps {
  days: number;
  selectedProjectId?: string;
  currentUserId: string;
  accessibleProjects: AccessibleProject[];
  windowLabel: string;
  summary: TelemetrySummary;
  previous: TelemetrySummary;
  series: DailyMetric[];
  tools: ToolMetric[];
  projects: ProjectMetric[];
  errors: ErrorMetric[];
  curator: CuratorMetric;
  projectFacts: number;
  sessionSummaries: number;
  maxDailyCalls: number;
  displayDay(date: string): string;
  displayIso(value: string | null): string;
  queryLink(days: number): string;
}

export function DashboardOverview({
  days, selectedProjectId, currentUserId, accessibleProjects, windowLabel, summary, previous,
  series, tools, projects, errors, curator, projectFacts, sessionSummaries, maxDailyCalls,
  displayDay, displayIso, queryLink,
}: DashboardOverviewProps) {
  const cards = [
    ['呼び出し', summary.calls, previous.calls],
    ['read', summary.reads, previous.reads],
    ['write', summary.writes, previous.writes],
    ['meta', summary.meta, previous.meta],
    ['connect', summary.connects, previous.connects],
    ['エラー', summary.errors, previous.errors],
  ] as const;

  return (
    <main className="dashboard-shell">
      <header className="dashboard-heading">
        <div>
          <p className="eyebrow">OPERATIONS</p>
          <h1>利用状況</h1>
          <p className="muted">{windowLabel}（JST・{days}日）{selectedProjectId ? ' / project: ' + selectedProjectId : ''}</p>
        </div>
        <nav className="period-filter" aria-label="期間">
          {[7, 30, 90].map((preset) => (
            <a key={preset} className={days === preset ? 'is-active' : undefined} href={queryLink(preset)}>{preset}日</a>
          ))}
        </nav>
      </header>

      <ProjectManagementPanel
        initialProjects={accessibleProjects}
        currentUserId={currentUserId}
        selectedProjectId={selectedProjectId}
      />

      <section className="analytics-panel" aria-labelledby="summary-heading">
        <div className="section-heading"><p className="eyebrow">TELEMETRY</p><h2 id="summary-heading">概要</h2></div>
        <div className="metric-grid">
          {cards.map(([label, value, oldValue]) => (
            <article key={label} className="metric-card">
              <strong>{label}</strong><div className="metric-value">{value}</div>
              <Delta current={value} previous={oldValue} />
            </article>
          ))}
        </div>
        <div className="metric-footnotes">
          <span>エラー率: {(summary.errorRate * 100).toFixed(1)}% / calls per connect: {summary.callsPerConnect.toFixed(2)}</span>
          <span>readless connection: {(summary.readlessRate * 100).toFixed(1)}%（{summary.connectionsWithRead}/{summary.connectionsTracked}）</span>
        </div>
      </section>

      <section className="analytics-panel" aria-labelledby="daily-heading">
        <div className="section-heading"><p className="eyebrow">ACTIVITY</p><h2 id="daily-heading">日次推移</h2></div>
        <div className="daily-series">
          {series.map((day) => (
            <div key={day.date} className="daily-row">
              <time dateTime={day.date}>{displayDay(day.date)}</time>
              <Bar value={day.reads + day.writes + day.meta} max={maxDailyCalls} label={day.date + ' calls'} />
              <Sparkline values={[day.reads, day.writes, day.meta]} />
            </div>
          ))}
        </div>
      </section>

      <section className="analytics-panel" aria-labelledby="alerts-heading">
        <div className="section-heading"><p className="eyebrow">CHECKS</p><h2 id="alerts-heading">アラート</h2></div>
        <ul className="status-list">
          {summary.r1Suppressed
            ? <li>R1: 未帰属呼び出しが多いため readless 判定を抑制中</li>
            : <li>R1: {summary.readlessRate > 0.5 ? 'readless connection が 50% 超' : '正常'}</li>}
          <li>R4: {projectFacts > sessionSummaries ? 'remember_project_fact が session summary を上回っています' : '正常'}</li>
          <li>R6: {curator.stale ? 'curator が stale（最終成功: ' + displayIso(curator.lastWriteIso) + '）' : '正常（最終成功: ' + displayIso(curator.lastWriteIso) + '）'}</li>
        </ul>
      </section>

      <section className="data-panel" aria-labelledby="tools-heading">
        <div className="section-heading"><p className="eyebrow">CATALOG</p><h2 id="tools-heading">ツール別</h2></div>
        <div className="table-scroll"><table>
          <thead><tr><th>tool</th><th>kind</th><th>calls</th><th>error rate</th><th>zero results</th><th>result chars p95</th><th>last used</th></tr></thead>
          <tbody>{tools.map((tool) => (
            <tr key={tool.tool}>
              <td>{tool.tool}</td><td>{tool.kind}</td><td>{tool.calls}</td>
              <td>{(tool.errorRate * 100).toFixed(1)}%</td><td>{(tool.zeroResultsRate * 100).toFixed(1)}%</td>
              <td>{tool.result_chars_p95}</td><td>{displayIso(tool.lastUsedAt)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>

      <section className="data-panel" aria-labelledby="projects-heading">
        <div className="section-heading"><p className="eyebrow">SCOPE</p><h2 id="projects-heading">プロジェクト別</h2></div>
        <div className="table-scroll"><table>
          <thead><tr><th>project</th><th>calls</th><th>connects</th><th>errors</th><th>maintenance writes</th></tr></thead>
          <tbody>{projects.map((project) => (
            <tr key={project.project_id}><td>{project.project_id}</td><td>{project.calls}</td><td>{project.connects}</td><td>{project.errors}</td><td>{project.maintenanceWrites}</td></tr>
          ))}</tbody>
        </table></div>
      </section>

      <section className="analytics-panel" aria-labelledby="errors-heading">
        <div className="section-heading"><p className="eyebrow">RELIABILITY</p><h2 id="errors-heading">エラー内訳</h2></div>
        {errors.length === 0 ? <p className="muted">エラーなし</p> : <ul className="status-list">{errors.map((error) => <li key={error.error_code + '-' + error.tool}>{error.error_code} / {error.tool}: {error.calls}</li>)}</ul>}
        <p className="muted">maintenance writes: {series.reduce((total, day) => total + day.maintenanceWrites, 0)}</p>
      </section>
    </main>
  );
}
