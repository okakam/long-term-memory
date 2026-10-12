import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import { MaintenancePanel } from '@/components/project-management/MaintenancePanel';

test('owner向けmaintenance panelに設定、archive、revision UIを表示する', () => {
  const html = renderToStaticMarkup(createElement(MaintenancePanel, { projectId: 'alpha' }));
  expect(html).toContain('自動棚卸し');
  expect(html).toContain('review日数');
  expect(html).toContain('archive');
  expect(html).toContain('revision');
});
