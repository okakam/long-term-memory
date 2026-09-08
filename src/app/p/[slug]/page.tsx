import Link from 'next/link';

import { authorizeWebProject } from '@/lib/web/access';
import { getMemoryService } from '@/lib/memory/singleton';
import { MEMORY_TYPES } from '@/lib/memory/types';
import { isReservedProjectId, isValidSlug } from '@/lib/slug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ slug: string }>;

export default async function ProjectPage({ params }: { params: Params }) {
  const { slug } = await params;
  if (!isValidSlug(slug) && !isReservedProjectId(slug)) return <main><p>Invalid project slug.</p></main>;
  await authorizeWebProject(slug);
  const service = getMemoryService();
  const counts = await Promise.all(MEMORY_TYPES.map(async (type) => ({ type, count: (await service.listByType(slug, type, 500)).length })));
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  return (
    <main>
      <p><Link href="/">Projects</Link> / {slug}</p>
      <h1>{slug}{slug === '__shared__' ? <span className="tag">shared</span> : null}</h1>
      <p>{total} memories</p>
      <ul>{counts.map((item) => <li key={item.type}><Link href={'/p/' + encodeURIComponent(slug) + '/memories?type=' + item.type}>{item.type}</Link>: {item.count}</li>)}</ul>
      <p><Link href={'/p/' + encodeURIComponent(slug) + '/memories'}>Browse memories</Link> · <Link href={'/p/' + encodeURIComponent(slug) + '/graph'}>Knowledge graph</Link></p>
    </main>
  );
}
