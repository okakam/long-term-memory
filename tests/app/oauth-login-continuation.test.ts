import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import SignInPage from '@/app/sign-in/[[...sign-in]]/page';
import SignUpPage from '@/app/sign-up/[[...sign-up]]/page';

const transaction = `ltm_oatx_${'a'.repeat(43)}`;

afterEach(() => vi.restoreAllMocks());

test('sign-in pageは有効なOAuth transactionだけを安全な相対URLへ変換する', async () => {
  const markup = renderToStaticMarkup(await SignInPage({
    searchParams: Promise.resolve({ oauth_transaction: transaction }),
  }));

  expect(markup).toContain(`/sign-up?oauth_transaction=${transaction}`);
  expect(markup).not.toContain('https://evil.example');
});

test('sign-up pageもtransactionを保持し、外部URLや不正値は破棄する', async () => {
  const valid = renderToStaticMarkup(await SignUpPage({
    searchParams: Promise.resolve({ oauth_transaction: transaction }),
  }));
  expect(valid).toContain(`/sign-in?oauth_transaction=${transaction}`);

  const invalid = renderToStaticMarkup(await SignInPage({
    searchParams: Promise.resolve({
      oauth_transaction: 'https://evil.example/steal?next=/oauth/authorize',
    }),
  }));
  expect(invalid).not.toContain('evil.example');
  expect(invalid).not.toContain('oauth_transaction');
  expect(invalid).toContain('href="/sign-up"');
});
