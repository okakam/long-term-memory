'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import {
  establishSession,
  signInWithGoogle,
  signInWithPassword,
  signUpWithPassword,
} from '@/lib/auth/firebase-client';

export function FirebaseAuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function complete(credential: Awaited<ReturnType<typeof signInWithPassword>>) {
    await establishSession(credential);
    router.push('/');
    router.refresh();
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
      setError(cause instanceof Error ? cause.message : '認証に失敗しました');
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
      setError(cause instanceof Error ? cause.message : 'Google認証に失敗しました');
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
      {error ? <p className="error-message">{error}</p> : null}
    </section>
  );
}
