import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ToolContext } from '../context';
import { ReindexInput } from '../schemas';
import { json, text } from './util';

export function registerMetaTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('list_projects', {
    description: 'List all projects that have memories, with counts and last-update.',
  }, async () => json(ctx.svc.listProjects()));
  server.registerTool('reindex', {
    description: 'Rebuild the SQLite index from markdown files. Useful after external edits.',
    inputSchema: ReindexInput,
  }, async () => {
    await Promise.resolve(ctx.svc.reindex());
    return text('reindex complete');
  });
}
