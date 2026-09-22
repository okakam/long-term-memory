import { FirebaseAuthForm } from '@/components/FirebaseAuthForm';
import { oauthAuthorizationContinuation } from '@/lib/oauth/continuation';

export const dynamic = 'force-dynamic';

type SignUpPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignUpPage({ searchParams }: SignUpPageProps = {}) {
  const params = searchParams ? await searchParams : undefined;
  const continuation = oauthAuthorizationContinuation(params?.oauth_transaction);
  return <main><FirebaseAuthForm mode="sign-up" continuation={continuation} /></main>;
}
