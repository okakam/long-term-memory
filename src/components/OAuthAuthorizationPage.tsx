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
  :root{color-scheme:dark;color:#e7eaf3;background:#06080e;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(800px 500px at 10% -10%,rgba(99,102,241,.22),transparent 62%),radial-gradient(700px 460px at 100% 0%,rgba(34,211,238,.13),transparent 60%),#06080e}.oauth-shell{display:grid;min-height:100vh;place-items:center;padding:24px}.oauth-card{position:relative;width:min(100%,480px);padding:36px;border:1px solid rgba(148,163,196,.14);border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,.04),transparent 40%),rgba(16,20,32,.82);border-color:rgba(99,102,241,.35);box-shadow:0 24px 60px rgba(0,0,0,.5),0 0 60px rgba(99,102,241,.22),0 0 120px rgba(34,211,238,.1)}.oauth-eyebrow{margin:0 0 8px;background:linear-gradient(135deg,#22d3ee,#6366f1 55%,#a855f7);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:11px;font-weight:800;letter-spacing:.18em;text-transform:uppercase}.oauth-card h1{margin:0 0 24px;color:#fff;letter-spacing:-.04em;font-size:32px}.oauth-client{margin:0 0 16px;font-size:16px;line-height:1.6}.oauth-scope{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 16px;padding:13px;border:1px solid rgba(148,163,196,.14);border-radius:11px;background:rgba(6,8,14,.55);color:#8a93a8;font-size:13px}.oauth-scope code{color:#67e8f9;font-weight:700}.oauth-note{margin:0 0 25px;color:#8a93a8;font-size:13px;line-height:1.55}.oauth-actions{display:grid;gap:9px}.oauth-actions button{min-height:42px;border:1px solid rgba(148,163,196,.26);border-radius:10px;background:rgba(24,30,47,.7);color:#e7eaf3;cursor:pointer;font:650 14px inherit;transition:filter .16s ease,box-shadow .16s ease}.oauth-actions .oauth-approve{border-color:transparent;background:linear-gradient(135deg,#22d3ee,#6366f1 55%,#a855f7);color:#fff;box-shadow:0 8px 24px rgba(99,102,241,.35)}.oauth-actions button:hover{filter:brightness(1.1)}.oauth-actions button:focus-visible{outline:2px solid rgba(34,211,238,.7);outline-offset:2px}@media(max-width:500px){.oauth-card{padding:27px 22px}.oauth-card h1{font-size:28px}}@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important;animation-duration:.01ms!important}}</style>`;

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
