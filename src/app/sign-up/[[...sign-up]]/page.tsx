import { FirebaseAuthForm } from '@/components/FirebaseAuthForm';

export const dynamic = 'force-dynamic';

export default function SignUpPage() {
  return <main><FirebaseAuthForm mode="sign-up" /></main>;
}
