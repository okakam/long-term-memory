import type { ReactElement } from 'react';

export type OAuthAuthorizationPageProps = {
  transactionId: string;
  csrfToken: string;
  clientName: string;
  scope: string;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] ?? character);
}

const oauthStyles = `<style>
  :root{color:#20212b;background:#f7f7fb;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top left,#fff 0,#f5f4fb 44%,#efeff7 100%)}.oauth-shell{display:grid;min-height:100vh;place-items:center;padding:24px}.oauth-card{width:min(100%,480px);padding:36px;border:1px solid #e0e1eb;border-radius:16px;background:rgba(255,255,255,.9);box-shadow:0 18px 50px rgba(39,40,62,.1)}.oauth-eyebrow{margin:0 0 8px;color:#4f46e5;font-size:11px;font-weight:800;letter-spacing:.13em}.oauth-card h1{margin:0 0 24px;letter-spacing:-.04em;font-size:32px}.oauth-client{margin:0 0 16px;font-size:16px;line-height:1.6}.oauth-scope{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 16px;padding:13px;border:1px solid #e4e5ee;border-radius:10px;background:#fbfbff;color:#666879;font-size:13px}.oauth-scope code{color:#3730a3;font-weight:700}.oauth-note{margin:0 0 25px;color:#6f7180;font-size:13px;line-height:1.55}.oauth-actions{display:grid;gap:9px}.oauth-actions button{min-height:42px;border:1px solid #cfd1df;border-radius:9px;background:#fff;color:#30313d;cursor:pointer;font:650 14px inherit}.oauth-actions .oauth-approve{border-color:#4f46e5;background:#4f46e5;color:#fff}.oauth-actions button:hover{filter:brightness(.97)}.oauth-actions button:focus-visible{outline:3px solid rgba(79,70,229,.4);outline-offset:2px}@media(max-width:500px){.oauth-card{padding:27px 22px}.oauth-card h1{font-size:28px}}@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important;animation-duration:.01ms!important}}</style>`;

export function renderOAuthAuthorizationPage({ transactionId, csrfToken, clientName, scope }: OAuthAuthorizationPageProps): string {
  return `${oauthStyles}<main class="oauth-shell"><section class="oauth-card"><p class="oauth-eyebrow">Long term memory</p><h1>MCP接続を許可</h1><p class="oauth-client"><strong>${escapeHtml(clientName)}</strong> が long-term-memory MCP への接続を要求しています。</p><p class="oauth-scope"><span>付与される範囲</span><code>${escapeHtml(scope)}</code></p><p class="oauth-note">project membershipとtool権限は、MCPリクエストごとに再確認されます。</p><form class="oauth-actions" method="post" action="/oauth/authorize"><input type="hidden" name="transaction_id" value="${escapeHtml(transactionId)}"/><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"/><button class="oauth-approve" type="submit" name="decision" value="approve">許可</button><button type="submit" name="decision" value="deny">拒否</button></form></section></main>`;
}

export function OAuthAuthorizationPage({ transactionId, csrfToken, clientName, scope }: OAuthAuthorizationPageProps): ReactElement {
  return (
    <main className="oauth-shell">
      <section className="oauth-card">
        <p className="oauth-eyebrow">Long term memory</p>
        <h1>MCP接続を許可</h1>
        <p className="oauth-client"><strong>{clientName}</strong> が long-term-memory MCP への接続を要求しています。</p>
        <p className="oauth-scope"><span>付与される範囲</span><code>{scope}</code></p>
        <p className="oauth-note">project membershipとtool権限は、MCPリクエストごとに再確認されます。</p>
        <form className="oauth-actions" method="post" action="/oauth/authorize">
          <input type="hidden" name="transaction_id" value={transactionId} />
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <button className="oauth-approve" type="submit" name="decision" value="approve">許可</button>
          <button type="submit" name="decision" value="deny">拒否</button>
        </form>
      </section>
    </main>
  );
}
