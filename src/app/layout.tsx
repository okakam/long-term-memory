import { ClerkProvider } from '@clerk/nextjs';
import type { ReactNode } from 'react';

import './globals.css';
import { Header } from '@/components/Header';

export default function RootLayout({ children }: { children: ReactNode }) {
  return <ClerkProvider><html lang="ja"><body><Header />{children}</body></html></ClerkProvider>;
}
