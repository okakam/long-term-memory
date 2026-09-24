import { DashboardOverview } from '@/components/dashboard/DashboardOverview';
import type { AccessibleProject } from '@/components/project-management/ProjectManagementPanel';
import { assertProjectAccess } from '@/lib/auth/access';
import { authRequired } from '@/lib/auth/config';
import { requireWebPrincipal } from '@/lib/auth/web-principal';
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

  const principal = await requireWebPrincipal();
  let accessibleProjects: AccessibleProject[] = [];
  let projectIds: Set<string> | undefined;
  if (authRequired()) {
    const accessible = await (await getAuthStore()).listAccessibleProjects(principal.userId);
    accessibleProjects = accessible.map(({ project_id, role }) => ({ project_id, role }));
    if (requestedProject) {
      await assertProjectAccess(principal, requestedProject, 'read');
      projectIds = new Set([requestedProject]);
    } else {
      projectIds = new Set([...accessible.map((project) => project.project_id), '__shared__']);
    }
  } else if (requestedProject) {
    projectIds = new Set([requestedProject]);
    accessibleProjects = [{ project_id: requestedProject, role: 'owner' }];
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

  return <DashboardOverview
    days={days}
    selectedProjectId={requestedProject}
    currentUserId={principal.userId}
    accessibleProjects={accessibleProjects}
    windowLabel={displayIso(window.start.toISOString()) + ' — ' + displayIso(window.end.toISOString())}
    summary={summary}
    previous={previous}
    series={series}
    tools={tools}
    projects={projects}
    errors={errors}
    curator={curator}
    projectFacts={projectFacts}
    sessionSummaries={sessionSummaries}
    maxDailyCalls={maxDailyCalls}
    displayDay={displayDay}
    displayIso={displayIso}
    queryLink={(preset) => queryLink(preset, requestedProject)}
  />;
}
