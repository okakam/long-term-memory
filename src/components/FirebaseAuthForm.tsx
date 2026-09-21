'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import {
  establishSession,
  signInWithGoogle,
  signInWithPassword,
  signUpWithPassword,
} from '@/lib/auth/firebase-client';
import { getFirebaseAuthErrorMessage } from '@/lib/auth/auth-error';
import { authSwitchHref } from '@/lib/oauth/continuation';

export type FirebaseAuthFormProps = {
  mode: 'sign-in' | 'sign-up';
  continuation?: string | null;
};

type AuthRouter = Pick<ReturnType<typeof useRouter>, 'push' | 'refresh'>;

export async function completeFirebaseAuth(
  credential: Awaited<ReturnType<typeof signInWithPassword>>,
  continuation: string | null | undefined,
  router: AuthRouter,
): Promise<void> {
  await establishSession(credential);
  router.push(continuation ?? '/');
  router.refresh();
}

export function FirebaseAuthForm({ mode, continuation = null }: FirebaseAuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function complete(credential: Awaited<ReturnType<typeof signInWithPassword>>) {
    await completeFirebaseAuth(credential, continuation, router);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await complete(mode === 'sign-in'
        ? await signInWithPassword(email, password)
        : await signUpWithPassword(email, password));
    } catch (cause) {
      setError(getFirebaseAuthErrorMessage(cause, '認証に失敗しました'));
    } finally {
      setPending(false);
    }
  }

  async function google() {
    setPending(true);
    setError(null);
    try {
      await complete(await signInWithGoogle());
    } catch (cause) {
      setError(getFirebaseAuthErrorMessage(cause, 'Google認証に失敗しました'));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="auth-card">
      <h1>{mode === 'sign-in' ? 'ログイン' : 'アカウント作成'}</h1>
      <form onSubmit={submit}>
        <label>メールアドレス<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label>パスワード<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={6} required /></label>
        <button type="submit" disabled={pending}>{pending ? '処理中…' : mode === 'sign-in' ? 'ログイン' : '登録'}</button>
      </form>
      <button type="button" onClick={google} disabled={pending}>Googleで続行</button>
      <p>
        {mode === 'sign-in' ? 'アカウントをお持ちでない場合は' : 'すでにアカウントをお持ちの場合は'}{' '}
        <a href={authSwitchHref(mode === 'sign-in' ? '/sign-up' : '/sign-in', continuation)}>
          {mode === 'sign-in' ? '登録' : 'ログイン'}
        </a>
      </p>
      {error ? <p className="error-message">{error}</p> : null}
    </section>
  );
}
