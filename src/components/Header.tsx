import Link from 'next/link';

import { AuthControls } from '@/components/AuthControls';

export function Header() {
  return (
    <header className="app-header">
      <Link className="brand" href="/">長期記憶</Link>
      <nav aria-label="メインナビゲーション">
        <Link href="/">プロジェクト</Link>
        <Link href="/search">検索</Link>
        <Link href="/dashboard">ダッシュボード</Link>
        <AuthControls />
      </nav>
    </header>
  );
}
