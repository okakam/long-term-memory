import { FirebaseAuthForm } from '@/components/FirebaseAuthForm';

export const dynamic = 'force-dynamic';

export default function SignInPage() {
  return <main><FirebaseAuthForm mode="sign-in" /></main>;
}
