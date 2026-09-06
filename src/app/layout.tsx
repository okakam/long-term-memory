import { ClerkProvider } from '@clerk/nextjs';
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return <ClerkProvider><html lang="ja"><body>{children}</body></html></ClerkProvider>;
}
