import { ProjectManagementPanel, type AccessibleProject } from '@/components/project-management/ProjectManagementPanel';
import { assertProjectAccess } from '@/lib/auth/access';
import { authRequired } from '@/lib/auth/config';
import { getAuthStore } from '@/lib/auth/store';
import { requireWebPrincipal } from '@/lib/auth/web-principal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ProjectsPage({ searchParams }: { searchParams: SearchParams }) {
  const { project } = await searchParams;
  const requestedProject = Array.isArray(project) ? project[0] : project;

  const principal = await requireWebPrincipal();
  let accessibleProjects: AccessibleProject[] = [];
  if (authRequired()) {
    const accessible = await (await getAuthStore()).listAccessibleProjects(principal.userId);
    accessibleProjects = accessible.map(({ project_id, role }) => ({ project_id, role }));
    if (requestedProject) await assertProjectAccess(principal, requestedProject, 'read');
  } else if (requestedProject) {
    accessibleProjects = [{ project_id: requestedProject, role: 'owner' }];
  }

  return (
    <main className="dashboard-shell">
      <header className="dashboard-heading">
        <div>
          <p className="eyebrow">PROJECTS</p>
          <h1>プロジェクト管理</h1>
          <p className="muted">プロジェクトの作成、メンバー、自動棚卸しを管理します。</p>
        </div>
      </header>
      <ProjectManagementPanel
        initialProjects={accessibleProjects}
        currentUserId={principal.userId}
        selectedProjectId={requestedProject}
        canManageShared={Boolean(process.env.LTM_CURATOR_USER_ID && principal.userId === process.env.LTM_CURATOR_USER_ID)}
      />
    </main>
  );
}
