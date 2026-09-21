import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  establishSession: vi.fn(async () => undefined),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/auth/firebase-client', () => ({
  establishSession: mocks.establishSession,
  signInWithGoogle: vi.fn(),
  signInWithPassword: vi.fn(),
  signUpWithPassword: vi.fn(),
}));

import { completeFirebaseAuth, FirebaseAuthForm } from '@/components/FirebaseAuthForm';

afterEach(() => {
  mocks.establishSession.mockClear();
});

test('Firebase session確立後はOAuth continuationへ遷移し、更新する', async () => {
  const router = { push: vi.fn(), refresh: vi.fn() };
  const credential = {} as Parameters<typeof completeFirebaseAuth>[0];
  await completeFirebaseAuth(credential, '/oauth/authorize?oauth_transaction=ltm_oatx_test', router);

  expect(mocks.establishSession).toHaveBeenCalledWith(credential);
  expect(router.push).toHaveBeenCalledWith('/oauth/authorize?oauth_transaction=ltm_oatx_test');
  expect(router.refresh).toHaveBeenCalledOnce();
});

test('continuationがなければ通常ログインと同じくrootへ遷移する', async () => {
  const router = { push: vi.fn(), refresh: vi.fn() };
  const credential = {} as Parameters<typeof completeFirebaseAuth>[0];
  await completeFirebaseAuth(credential, null, router);
  expect(router.push).toHaveBeenCalledWith('/');
});

test('ログインフォームの相互リンクはOAuth transactionだけを保持する', () => {
  const transaction = `ltm_oatx_${'b'.repeat(43)}`;
  const markup = renderToStaticMarkup(createElement(FirebaseAuthForm, {
    mode: 'sign-in',
    continuation: `/oauth/authorize?oauth_transaction=${transaction}`,
  }));
  expect(markup).toContain(`/sign-up?oauth_transaction=${transaction}`);
  expect(markup).not.toContain('access_token');
  expect(markup).not.toContain('code_challenge');
});
