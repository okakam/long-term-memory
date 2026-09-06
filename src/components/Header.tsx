import Link from 'next/link';

export function Header() {
  return (
    <header className="app-header">
      <Link className="brand" href="/">長期記憶</Link>
      <nav aria-label="メインナビゲーション">
        <Link href="/">Projects</Link>
        <Link href="/search">Search</Link>
        <Link href="/dashboard">Dashboard</Link>
      </nav>
    </header>
  );
}
