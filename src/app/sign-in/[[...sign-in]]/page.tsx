import { FirebaseAuthForm } from '@/components/FirebaseAuthForm';
import { oauthAuthorizationContinuation } from '@/lib/oauth/continuation';

export const dynamic = 'force-dynamic';

type SignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignInPage({ searchParams }: SignInPageProps = {}) {
  const params = searchParams ? await searchParams : undefined;
  const continuation = oauthAuthorizationContinuation(params?.oauth_transaction);
  return <main className="auth-shell"><FirebaseAuthForm mode="sign-in" continuation={continuation} /></main>;
}
