import { expect, test } from 'vitest';

import { renderOAuthAuthorizationPage } from '@/components/OAuthAuthorizationPage';

test('OAuth同意画面は安全なPOST formを維持し認証shellを描画する', () => {
  const html = renderOAuthAuthorizationPage({
    transactionId: 'ltm_oatx_test',
    csrfToken: 'csrf-token',
    clientName: '<Codex>',
    scope: 'mcp:access',
  });

  expect(html).toContain('class="oauth-shell"');
  expect(html).toContain('method="post" action="/oauth/authorize"');
  expect(html).toContain('name="transaction_id" value="ltm_oatx_test"');
  expect(html).toContain('name="csrf_token" value="csrf-token"');
  expect(html).toContain('name="decision" value="approve"');
  expect(html).toContain('&lt;Codex&gt;');
});
