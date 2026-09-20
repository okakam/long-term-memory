'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { signOutFirebase, subscribeFirebaseAuth } from '@/lib/auth/firebase-client';

export function AuthControls() {
  const router = useRouter();
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => subscribeFirebaseAuth(setSignedIn), []);

  if (!signedIn) return <><Link href="/sign-in">ログイン</Link><Link href="/sign-up">登録</Link></>;
  return <button type="button" onClick={async () => { await signOutFirebase(); router.refresh(); }}>ログアウト</button>;
}
