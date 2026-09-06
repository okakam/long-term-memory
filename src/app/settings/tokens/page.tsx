import { requireWebPrincipal } from '@/lib/auth/clerk';
import { listPats } from '@/lib/auth/pat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function TokenSettingsPage() {
  const principal = await requireWebPrincipal();
  const tokens = await listPats(principal.userId);
  return <main>
    <h1>MCP トークン</h1>
    <p>トークンは作成時に一度だけ表示されます。再表示はできません。</p>
    <ul>{tokens.map((token) => <li key={token.id}>
      <span>{token.token_prefix}…</span> {token.label}
      {token.revoked_at ? '（失効）' : ''}
    </li>)}</ul>
  </main>;
}
