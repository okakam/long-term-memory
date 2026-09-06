import Link from 'next/link';

import { formatJst } from '@/lib/datetime';
import { getMemoryService } from '@/lib/memory/singleton';
import { visibleWebProjects } from '@/lib/web/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Home() {
  const allowed = await visibleWebProjects();
  const projects = (await getMemoryService().listProjects()).filter((project) => !allowed || allowed.has(project.id));
  return (
    <main>
      <h1>Projects</h1>
      {projects.length === 0 ? <p>No projects yet. Save a memory via the MCP tools, then it will appear here.</p> : (
        <table>
          <thead><tr><th>Project</th><th>Memories</th><th>Last updated (JST)</th></tr></thead>
          <tbody>{projects.map((project) => (
            <tr key={project.id}>
              <td><Link href={'/p/' + encodeURIComponent(project.id)}>{project.id}</Link>{project.shared ? <span className="tag">shared</span> : null}</td>
              <td>{project.count}</td>
              <td>{project.updated_at ? formatJst(project.updated_at) : '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </main>
  );
}
