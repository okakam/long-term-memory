import Link from 'next/link';

import { getMemoryService } from '@/lib/memory/singleton';
import { visibleWebProjects } from '@/lib/web/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const query = first(params.q);
  const allowed = await visibleWebProjects();
  const service = getMemoryService();
  const projects = service.listProjects().filter((project) => !allowed || allowed.has(project.id));
  const results = query ? projects.flatMap((project) => service.searchFulltext(project.id, query, { limit: 50 }).map((memory) => ({ project, memory }))) : [];

  return (
    <main>
      <h1>Search memories</h1>
      <form method="get" action="/search" className="actions">
        <label htmlFor="q">Query</label>
        <input id="q" name="q" defaultValue={query} placeholder="topic" />
        <button type="submit">Search</button>
      </form>
      {!query ? <p>Enter a query to search every accessible project.</p> : results.length === 0 ? <p>No memories found.</p> : (
        <table>
          <thead><tr><th>Project</th><th>Name</th><th>Type</th><th>Description</th></tr></thead>
          <tbody>{results.map(({ project, memory }) => (
            <tr key={project.id + ':' + memory.id}>
              <td>{project.id}</td>
              <td><Link href={'/p/' + encodeURIComponent(project.id) + '/memories/' + encodeURIComponent(memory.name)}>{memory.name}</Link></td>
              <td><span className={'type-badge type-' + memory.type}>{memory.type}</span></td>
              <td>{memory.description}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </main>
  );
}
