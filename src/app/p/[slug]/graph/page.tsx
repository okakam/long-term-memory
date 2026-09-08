import Link from 'next/link';

import { KgGraph } from '@/components/KgGraph';
import { authorizeWebProject } from '@/lib/web/access';
import { getMemoryService } from '@/lib/memory/singleton';
import { isReservedProjectId, isValidSlug } from '@/lib/slug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ slug: string }>;

export default async function GraphPage({ params }: { params: Params }) {
  const { slug } = await params;
  if (!isValidSlug(slug) && !isReservedProjectId(slug)) return <main><p>Invalid project slug.</p></main>;
  await authorizeWebProject(slug);
  const data = await getMemoryService().readKgGraph(slug);
  return (
    <main>
      <p><Link href={'/p/' + encodeURIComponent(slug)}>{slug}</Link> / graph</p>
      <h1>Knowledge graph</h1>
      <p>memories: {data.memories.length} / entities: {data.entities.length} / edges: {data.edges.length}</p>
      <KgGraph data={data} projectId={slug} />
    </main>
  );
}
