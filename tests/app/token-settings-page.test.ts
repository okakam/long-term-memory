import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireWebPrincipal: vi.fn(async () => ({ userId: 'user-1' })),
  listPats: vi.fn(async () => []),
}));

vi.mock('@/lib/auth/web-principal', () => ({ requireWebPrincipal: mocks.requireWebPrincipal }));
vi.mock('@/lib/auth/pat', () => ({ listPats: mocks.listPats }));

import TokenSettingsPage from '@/app/settings/tokens/page';

test('PAT設定画面は発行フォームと一度だけ表示する案内を含む', async () => {
  const markup = renderToStaticMarkup(await TokenSettingsPage());

  expect(markup).toContain('PATを発行');
  expect(markup).toContain('作成時に一度だけ表示');
  expect(markup).toContain('token-label');
  expect(markup).toContain('発行');
});
