import { requireWebPrincipal } from '@/lib/auth/web-principal';
import { listPats } from '@/lib/auth/pat';
import { PatTokenSettings, type PatSummary } from '@/components/PatTokenSettings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function TokenSettingsPage() {
  const principal = await requireWebPrincipal();
  const tokens = await listPats(principal.userId);
  const summaries: PatSummary[] = tokens.map(({ id, token_prefix, label, created_at, expires_at, revoked_at }) => ({
    id,
    token_prefix,
    label,
    created_at,
    expires_at,
    revoked_at,
  }));
  return <main><PatTokenSettings initialTokens={summaries} /></main>;
}
