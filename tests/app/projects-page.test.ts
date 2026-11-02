import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireWebPrincipal: vi.fn(async () => ({ userId: 'user-1' })),
  listAccessibleProjects: vi.fn(async () => [{ project_id: 'alpha', role: 'owner' }]),
  getMembership: vi.fn(async (projectId: string) => projectId === 'alpha' ? { role: 'owner' } : null),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/auth/web-principal', () => ({ requireWebPrincipal: mocks.requireWebPrincipal }));
vi.mock('@/lib/auth/store', () => ({
  getAuthStore: async () => ({ listAccessibleProjects: mocks.listAccessibleProjects, getMembership: mocks.getMembership }),
}));

import ProjectsPage from '@/app/projects/page';
import { AuthorizationError } from '@/lib/auth/access';

beforeEach(() => {
  vi.stubEnv('AUTH_REQUIRED', '1');
  vi.stubEnv('LTM_CURATOR_USER_ID', 'curator');
});

test('プロジェクト管理画面は本人がアクセスできるprojectの管理パネルを表示する', async () => {
  const html = renderToStaticMarkup(await ProjectsPage({ searchParams: Promise.resolve({ project: 'alpha' }) }));

  expect(html).toContain('プロジェクト管理');
  expect(html).toContain('alpha (owner)');
  expect(html).toContain('メールアドレスで追加');
  expect(html).not.toContain('共有');
  expect(mocks.listAccessibleProjects).toHaveBeenCalledWith('user-1');
});

test('プロジェクト管理画面はmembershipのないprojectの指定を拒否する', async () => {
  await expect(ProjectsPage({ searchParams: Promise.resolve({ project: 'other' }) }))
    .rejects.toBeInstanceOf(AuthorizationError);
});
