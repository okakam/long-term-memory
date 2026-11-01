import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { ProjectManagementPanel } from '@/components/project-management/ProjectManagementPanel';

test('ownerにはproject作成とemailによるmember追加を表示する', () => {
  const html = renderToStaticMarkup(createElement(ProjectManagementPanel, {
    initialProjects: [{ project_id: 'alpha', role: 'owner' }],
    currentUserId: 'owner',
    selectedProjectId: 'alpha',
  }));

  expect(html).toContain('新しいプロジェクト');
  expect(html).toContain('メールアドレスで追加');
  expect(html).toContain('alpha');
});

test('memberにはmember追加操作を表示しない', () => {
  const html = renderToStaticMarkup(createElement(ProjectManagementPanel, {
    initialProjects: [{ project_id: 'alpha', role: 'member' }],
    currentUserId: 'member',
    selectedProjectId: 'alpha',
  }));

  expect(html).not.toContain('メールアドレスで追加');
});

test('project作成と対象選択を左列にまとめ、member管理を右列の独立した領域に置く', () => {
  const html = renderToStaticMarkup(createElement(ProjectManagementPanel, {
    initialProjects: [{ project_id: 'alpha', role: 'owner' }],
    currentUserId: 'owner',
    selectedProjectId: 'alpha',
  }));

  expect(html).toMatch(/<div class="project-management-sidebar"><form class="project-create-form"[\s\S]*id="managed-project"[\s\S]*?<\/select><\/div><section class="member-management"/);
});
