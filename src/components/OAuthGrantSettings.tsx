'use client';

import { useState } from 'react';

export interface OAuthGrantSummary {
  id: string;
  user_id: string;
  client_id: string;
  client_name: string;
  scope: 'mcp:access';
  resource: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export type OAuthGrantFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function revokeOAuthGrant(grantId: string, fetcher: OAuthGrantFetcher = fetch): Promise<void> {
  const response = await fetcher(`/api/auth/oauth-grants?grant_id=${encodeURIComponent(grantId)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('OAuth接続の失効に失敗しました。');
}

export function removeRevokedGrant(grants: OAuthGrantSummary[], grantId: string): OAuthGrantSummary[] {
  return grants.filter((grant) => grant.id !== grantId);
}

export function OAuthGrantSettings({ initialGrants }: { initialGrants: OAuthGrantSummary[] }) {
  const [grants, setGrants] = useState(initialGrants);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revoke(grantId: string) {
    setPending(grantId);
    setError(null);
    try {
      await revokeOAuthGrant(grantId);
      setGrants((current) => removeRevokedGrant(current, grantId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'OAuth接続の失効に失敗しました。');
    } finally {
      setPending(null);
    }
  }

  return <section aria-labelledby="oauth-grants-heading">
    <h2 id="oauth-grants-heading">Codex / OAuth 接続</h2>
    <p>この接続のaccess tokenとrefresh tokenを無効化します。</p>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {grants.length === 0 ? <p className="muted">OAuth接続はありません。</p> : <ul className="token-list">
      {grants.map((grant) => <li key={grant.id}>
        <strong>{grant.client_name}</strong>{' '}
        <code>{grant.scope}</code>{' '}
        <span>作成: <time dateTime={grant.created_at}>{grant.created_at}</time></span>{' '}
        <span>最終利用: {grant.last_used_at ? <time dateTime={grant.last_used_at}>{grant.last_used_at}</time> : '未使用'}</span>{' '}
        <button type="button" onClick={() => void revoke(grant.id)} disabled={pending !== null}>
          {pending === grant.id ? '失効中…' : '接続を失効'}
        </button>
      </li>)}
    </ul>}
  </section>;
}
