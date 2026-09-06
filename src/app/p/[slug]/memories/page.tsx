import Link from 'next/link';

import { DeleteMemoryButton } from '@/components/DeleteMemoryButton';
import { authorizeWebProject } from '@/lib/web/access';
import { getMemoryService } from '@/lib/memory/singleton';
import { bodyChars, MEMORY_TYPES, type Memory, type MemorySummary, type MemoryType } from '@/lib/memory/types';
import { isReservedProjectId, isValidSlug } from '@/lib/slug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ slug: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

function memoryHref(slug: string, name: string): string {
  return '/p/' + encodeURIComponent(slug) + '/memories/' + encodeURIComponent(name);
}

function toSummary(memory: Memory): MemorySummary {
  return {
    id: memory.id,
    name: memory.name,
    type: memory.type,
    description: memory.description,
    body_chars: bodyChars(memory.body),
    updated_at: memory.updated_at,
    tags: memory.tags,
    links: memory.links,
  };
}

function sortedUnique(items: MemorySummary[]): MemorySummary[] {
  return [...new Map(items.map((item) => [item.name, item])).values()]
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.name.localeCompare(right.name));
}

export default async function MemoriesPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { slug } = await params;
  if (!isValidSlug(slug) && !isReservedProjectId(slug)) return <main><p>Invalid project slug.</p></main>;
  await authorizeWebProject(slug);
  const query = await searchParams;
  const typeValue = first(query.type);
  const tag = first(query.tag);
  const type = isMemoryType(typeValue) ? typeValue : undefined;
  const service = getMemoryService();
  let memories: MemorySummary[];
  if (tag) {
    memories = (await service.searchByTag(slug, [tag], 'any')).map(toSummary);
    if (type) memories = memories.filter((memory) => memory.type === type);
  } else if (type) {
    memories = (await service.listByType(slug, type, 500)).map(toSummary);
  } else {
    memories = (await Promise.all(MEMORY_TYPES.map(async (memoryType) => (await service.listByType(slug, memoryType, 500)).map(toSummary)))).flat();
  }
  const supersededBy = await service.supersededByMap(slug);
  const shared = slug === '__shared__';

  return (
    <main>
      <p><Link href={'/p/' + encodeURIComponent(slug)}>{slug}</Link> / memories</p>
      <h1>Memories</h1>
      <form method="get" className="actions">
        <select name="type" defaultValue={type ?? ''}><option value="">All types</option>{MEMORY_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}</select>
        <input name="tag" defaultValue={tag} placeholder="tag (optional)" />
        <button type="submit">Filter</button>
      </form>
      {memories.length === 0 ? <p>No memories yet.</p> : (
        <table>
          <thead><tr><th>Name</th><th>Type</th><th>Description</th><th>Tags</th><th>Updated</th><th>Actions</th></tr></thead>
          <tbody>{sortedUnique(memories).map((memory) => {
            const replacement = supersededBy.get(memory.name);
            return (
              <tr key={memory.id}>
                <td><Link href={memoryHref(slug, memory.name)}>{memory.name}</Link>{replacement ? <span className="superseded-badge">置き換え済み → <Link href={memoryHref(slug, replacement)}>{replacement}</Link></span> : null}</td>
                <td><span className={'type-badge type-' + memory.type}>{memory.type}</span></td>
                <td>{memory.description}<div className="muted">{memory.body_chars} chars to read</div></td>
                <td>{memory.tags.map((tagName) => <span className="tag" key={tagName}>{tagName}</span>)}</td>
                <td>{memory.updated_at}</td>
                <td>{shared ? null : <DeleteMemoryButton projectId={slug} memoryName={memory.name} />}</td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
    </main>
  );
}
