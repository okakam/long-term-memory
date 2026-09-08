import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getAuthStore } from '@/lib/auth/store';

import type { ToolContext } from '../context';
import { ReindexInput } from '../schemas';
import { json, text } from './util';

export function registerMetaTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('list_projects', {
    description: 'List all projects that have memories, with counts and last-update.',
  }, async () => {
    const projects = await ctx.svc.listProjects();
    if (!ctx.principal) return json(projects);
    const allowed = new Set((await (await getAuthStore()).listAccessibleProjects(ctx.principal.userId)).map((project) => project.project_id));
    return json(projects.filter((project) => project.id === '__shared__' || allowed.has(project.id)));
  });
  server.registerTool('reindex', {
    description: 'Rebuild the SQLite index from markdown files. Useful after external edits.',
    inputSchema: ReindexInput,
  }, async () => {
    await Promise.resolve(ctx.svc.reindex(ctx.projectId));
    return text('reindex complete');
  });
}
