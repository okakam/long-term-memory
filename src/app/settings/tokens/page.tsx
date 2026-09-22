import { requireWebPrincipal } from '@/lib/auth/web-principal';
import { listPats } from '@/lib/auth/pat';
import { PatTokenSettings, type PatSummary } from '@/components/PatTokenSettings';
import { OAuthGrantSettings, type OAuthGrantSummary } from '@/components/OAuthGrantSettings';
import { OAuthService } from '@/lib/oauth/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function TokenSettingsPage() {
  const principal = await requireWebPrincipal();
  const [tokens, grants] = await Promise.all([
    listPats(principal.userId),
    new OAuthService().listGrants(principal.userId),
  ]);
  const summaries: PatSummary[] = tokens.map(({ id, token_prefix, label, created_at, expires_at, revoked_at }) => ({
    id,
    token_prefix,
    label,
    created_at,
    expires_at,
    revoked_at,
  }));
  const grantSummaries: OAuthGrantSummary[] = grants;
  return <main><PatTokenSettings initialTokens={summaries} /><OAuthGrantSettings initialGrants={grantSummaries} /></main>;
}
