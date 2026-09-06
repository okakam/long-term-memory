import { assertProjectAccess } from '@/lib/auth/access';
import { authRequired } from '@/lib/auth/config';
import { requireWebPrincipal } from '@/lib/auth/clerk';
import { getAuthStore } from '@/lib/auth/store';

export async function authorizeWebProject(projectId: string): Promise<void> {
  if (!authRequired()) return;
  const principal = await requireWebPrincipal();
  await assertProjectAccess(principal, projectId, 'read');
}

export async function visibleWebProjects(): Promise<Set<string> | null> {
  if (!authRequired()) return null;
  const principal = await requireWebPrincipal();
  const projects = await (await getAuthStore()).listAccessibleProjects(principal.userId);
  return new Set([...projects.map((project) => project.project_id), '__shared__']);
}
