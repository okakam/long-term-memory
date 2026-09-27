import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getAuthStore } from '@/lib/auth/store';

import type { ToolContext } from '../context';
import { ReindexInput } from '../schemas';
import { json, text } from './util';

export function registerMetaTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('list_projects', {
    description: 'Call this first to find accessible projects, then pass the chosen project_id to other tools.',
  }, async () => {
    if (!ctx.principal) return json(await ctx.svc.listProjects());
    const projects = await (await getAuthStore()).listAccessibleProjects(ctx.principal.userId);
    return json(projects.map(({ project_id, role, created_at, updated_at }) => ({
      project_id, role, created_at, updated_at,
    })));
  });
  server.registerTool('reindex', {
    description: 'Call list_projects first, then pass the chosen project_id as a top-level argument. Rebuild that project’s SQLite index from markdown files. Useful after external edits.',
    inputSchema: ReindexInput,
  }, async ({ project_id }) => {
    await ctx.requireProjectAccess(project_id, 'maintain');
    await Promise.resolve(ctx.svc.reindex(project_id));
    return text('reindex complete');
  });
}
