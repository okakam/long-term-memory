import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { MaintenanceService } from '@/lib/maintenance/service';
import { SHARED_PROJECT_ID } from '@/lib/slug';

import type { ToolContext } from '../context';
import { MaintenanceApplyInput, MaintenanceListProjectsInput, MaintenanceSnapshotInput } from '../schemas';
import { json } from './util';

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function registerMaintenanceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('maintenance_list_projects', {
    description: 'List ordinary projects whose owner has enabled automated maintenance.',
    inputSchema: MaintenanceListProjectsInput,
  }, async () => {
    const projects = await ctx.svc.listProjects();
    const optedIn = await Promise.all(projects
      .filter((project) => project.id !== SHARED_PROJECT_ID)
      .map(async (project) => {
        const settings = await ctx.svc.maintenanceStore.getSettings(project.id);
        return settings.enabled ? { project_id: project.id, settings_version: settings.version } : null;
      }));
    return json(optedIn.filter((project) => project !== null));
  });

  server.registerTool('maintenance_snapshot', {
    description: 'Read one page of active memories and verified maintenance candidates from an opted-in project.',
    inputSchema: MaintenanceSnapshotInput,
  }, async ({ project_id, after }) => {
    try {
      await ctx.requireProjectAccess(project_id, 'maintain');
      return json(await new MaintenanceService(ctx.svc).snapshot(project_id, new Date().toISOString(), after));
    } catch {
      return toolError('maintenance snapshot is unavailable for this project');
    }
  });

  server.registerTool('maintenance_apply', {
    description: 'Apply one citation-checked maintenance proposal to an opted-in project.',
    inputSchema: MaintenanceApplyInput,
  }, async ({ project_id, proposal }) => {
    try {
      await ctx.requireProjectAccess(project_id, 'maintain');
      const result = await new MaintenanceService(ctx.svc).apply(project_id, proposal);
      if (result.outcome === 'conflict') return toolError('maintenance proposal conflicted with current project state');
      return json(result);
    } catch {
      return toolError('maintenance proposal could not be applied');
    }
  });
}
