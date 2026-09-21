import type { ReactElement } from 'react';

export type OAuthAuthorizationPageProps = {
  transactionId: string;
  csrfToken: string;
  clientName: string;
  scope: string;
};

export function OAuthAuthorizationPage({ transactionId, csrfToken, clientName, scope }: OAuthAuthorizationPageProps): ReactElement {
  return (
    <main>
      <h1>MCP接続を許可</h1>
      <p><strong>{clientName}</strong> が long-term-memory MCP への接続を要求しています。</p>
      <p>付与される範囲: <code>{scope}</code></p>
      <p>project membershipとtool権限は、MCPリクエストごとに再確認されます。</p>
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="transaction_id" value={transactionId} />
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <button type="submit" name="decision" value="approve">許可</button>
        <button type="submit" name="decision" value="deny">拒否</button>
      </form>
    </main>
  );
}
