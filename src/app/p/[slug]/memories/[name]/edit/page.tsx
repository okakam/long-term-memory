import Link from 'next/link';

import MemoryEditor from '@/components/MemoryEditor';
import { authorizeWebProject } from '@/lib/web/access';
import { getMemoryService } from '@/lib/memory/singleton';
import { isReservedProjectId, isValidSlug } from '@/lib/slug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ slug: string; name: string }>;

export default async function EditMemoryPage({ params }: { params: Params }) {
  const { slug, name } = await params;
  if ((!isValidSlug(slug) && !isReservedProjectId(slug)) || !isValidSlug(name)) {
    return <main><p>Invalid project slug.</p></main>;
  }
  await authorizeWebProject(slug);
  if (slug === '__shared__') return <main><p>shared scope is read-only</p></main>;
  const memory = getMemoryService().get(slug, name);
  return <main><p><Link href={'/p/' + encodeURIComponent(slug) + '/memories/' + encodeURIComponent(name)}>{name}</Link> / edit</p><h1>Edit memory</h1><MemoryEditor memory={memory} projectId={slug} /></main>;
}
