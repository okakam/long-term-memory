import Link from 'next/link';

import { AuthControls } from '@/components/AuthControls';

export function Header() {
  return (
    <header className="app-header">
      <Link className="brand" href="/">Long term memory</Link>
      <nav aria-label="メインナビゲーション">
        <Link href="/dashboard">ダッシュボード</Link>
        <Link href="/">プロジェクト</Link>
        <Link href="/search">検索</Link>
        <Link href="/settings/tokens">設定</Link>
        <AuthControls />
      </nav>
    </header>
  );
}
