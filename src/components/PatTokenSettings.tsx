'use client';

import type { FormEvent } from 'react';
import { useState } from 'react';

export interface PatSummary {
  id: string;
  token_prefix: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

interface CreateTokenResponse {
  token?: unknown;
  token_id?: unknown;
}

function errorMessage(body: string): string {
  if (!body) return 'PATの発行に失敗しました。';
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    // API errors are normally plain text; use the response as-is below.
  }
  return body;
}

export function PatTokenSettings({ initialTokens }: { initialTokens: PatSummary[] }) {
  const [tokens, setTokens] = useState(initialTokens);
  const [label, setLabel] = useState('github-cloud-run-smoke');
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedLabel = label.trim();
    if (!normalizedLabel) {
      setError('ラベルを入力してください。');
      return;
    }

    setPending(true);
    setError(null);
    setCreatedToken(null);
    setCopyState('idle');

    try {
      const response = await fetch('/api/auth/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: normalizedLabel }),
      });
      const responseText = await response.text();
      let body: CreateTokenResponse | null = null;
      try {
        body = JSON.parse(responseText) as CreateTokenResponse;
      } catch {
        // Keep the plain-text response for a useful error message below.
      }

      const token = body?.token;
      const tokenId = body?.token_id;
      if (!response.ok || typeof token !== 'string' || typeof tokenId !== 'string') {
        throw new Error(response.ok ? 'PATの発行レスポンスが不正です。' : errorMessage(responseText));
      }

      setCreatedToken(token);
      setTokens((current) => [{
        id: tokenId,
        token_prefix: token.slice(0, 12),
        label: normalizedLabel,
        created_at: new Date().toISOString(),
        expires_at: null,
        revoked_at: null,
      }, ...current]);
      setLabel('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'PATの発行に失敗しました。');
    } finally {
      setPending(false);
    }
  }

  async function copyToken() {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return <>
    <h1>MCP トークン</h1>
    <p>発行したPATは作成時に一度だけ表示されます。再表示はできません。</p>

    <section className="card" aria-labelledby="pat-issue-heading">
      <h2 id="pat-issue-heading">PATを発行</h2>
      <p className="muted">GitHub Actionsの <code>LTM_MCP_TOKEN</code> など、用途が分かるラベルを付けてください。</p>
      <form className="token-form" onSubmit={handleSubmit}>
        <label htmlFor="token-label">ラベル</label>
        <input
          id="token-label"
          name="label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={100}
          required
        />
        <button className="primary" type="submit" disabled={pending}>
          {pending ? '発行中…' : 'PATを発行'}
        </button>
      </form>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </section>

    {createdToken ? <section className="card token-output" aria-labelledby="new-token-heading">
      <h2 id="new-token-heading">発行したPAT</h2>
      <p className="token-notice">このPATはこの画面を離れると再表示できません。GitHubへ登録するまで閉じないでください。</p>
      <code className="token-value" tabIndex={0}>{createdToken}</code>
      <div className="actions">
        <button type="button" onClick={copyToken}>PATをコピー</button>
        {copyState === 'copied' ? <span className="muted" role="status">コピーしました。</span> : null}
      </div>
      {copyState === 'failed' ? <p className="error" role="alert">自動コピーに失敗しました。上のPATを選択して手動でコピーしてください。</p> : null}
    </section> : null}

    <section aria-labelledby="token-list-heading">
      <h2 id="token-list-heading">発行済みPAT</h2>
      {tokens.length === 0 ? <p className="muted">発行済みのPATはありません。</p> : <ul className="token-list">
        {tokens.map((token) => <li key={token.id}>
          <code>{token.token_prefix}…</code> <span>{token.label}</span>
          {token.revoked_at ? '（失効）' : ''}
        </li>)}
      </ul>}
    </section>
  </>;
}
