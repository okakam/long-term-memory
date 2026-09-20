import Link from 'next/link';
import ReactMarkdown from 'react-markdown';

import { authorizeWebProject } from '@/lib/web/access';
import { formatJst } from '@/lib/datetime';
import { getMemoryService } from '@/lib/memory/singleton';
import { isReservedProjectId, isValidSlug } from '@/lib/slug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ slug: string; name: string }>;

function memoryHref(slug: string, name: string): string {
  return '/p/' + encodeURIComponent(slug) + '/memories/' + encodeURIComponent(name);
}

function sourceHref(projectId: string, name: string): string | null {
  if (!isValidSlug(projectId) && !isReservedProjectId(projectId)) return null;
  return memoryHref(projectId, name);
}

export default async function MemoryDetailPage({ params }: { params: Params }) {
  const { slug, name } = await params;
  if ((!isValidSlug(slug) && !isReservedProjectId(slug)) || !isValidSlug(name)) {
    return <main><p>Invalid project slug.</p></main>;
  }
  await authorizeWebProject(slug);
  const service = getMemoryService();
  const memory = await service.get(slug, name);
  const replacement = (await service.supersededByMap(slug)).get(memory.name);
  const shared = slug === '__shared__';

  return (
    <main>
      <p><Link href={'/p/' + encodeURIComponent(slug) + '/memories'}>{slug} / memories</Link></p>
      <article className="card">
        <p><span className={'type-badge type-' + memory.type}>{memory.type}</span>{shared ? <span className="tag">shared</span> : null}</p>
        <h1>{memory.name}</h1>
        <p>{memory.description}</p>
        {replacement ? <p className="superseded-badge">置き換え済み: <Link href={memoryHref(slug, replacement)}>{replacement}</Link></p> : null}
        <p>{memory.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</p>
        {memory.links.length > 0 ? <p>Links: {memory.links.map((link) => <Link href={memoryHref(slug, link)} key={link}>{link} </Link>)}</p> : null}
        {memory.entities.length > 0 ? <section><h2>Entities</h2><ul>{memory.entities.map((entity) => <li key={entity.name}>{entity.name}{entity.aliases.length > 0 ? <span title={entity.aliases.join(', ')}>（aliases: {entity.aliases.join(', ')}）</span> : null}</li>)}</ul></section> : null}
        {memory.triples.length > 0 ? <section><h2>Triples</h2><ul>{memory.triples.map((triple, index) => <li key={index}>{triple[0]} — {triple[1]} — {triple[2]}</li>)}</ul></section> : null}
        {memory.source_refs && memory.source_refs.length > 0 ? <section><h2>Sources</h2><ul>{memory.source_refs.map((source, index) => {
          const href = sourceHref(source.project_id, source.memory);
          return <li key={index}>{href ? <Link href={href}>{source.project_id}/{source.memory}</Link> : source.project_id + '/' + source.memory}</li>;
        })}</ul></section> : null}
        {memory.supersedes.length > 0 ? <p>Supersedes: {memory.supersedes.map((old) => <Link href={memoryHref(slug, old)} key={old}>{old} </Link>)}</p> : null}
        <dl><dt>ID</dt><dd>{memory.id}</dd><dt>Created</dt><dd>{formatJst(memory.created_at)}</dd><dt>Updated</dt><dd>{formatJst(memory.updated_at)}</dd></dl>
        {!shared ? <p><Link href={memoryHref(slug, memory.name) + '/edit'}>Edit</Link></p> : null}
      </article>
      <article className="card"><ReactMarkdown>{memory.body}</ReactMarkdown></article>
    </main>
  );
}
