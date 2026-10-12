import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getAuthStore } from '@/lib/auth/store';
import { CurationService } from '@/lib/curation/service';
import { applySharedRestore } from '@/lib/curation/restore';
import { SHARED_PROJECT_ID } from '@/lib/slug';
import type { SharedProposal } from '@/lib/curation/types';

import type { ToolContext } from '../context';
import { CurationApplyInput, CurationCheckpointInput, CurationSnapshotInput } from '../curation-schemas';
import { json } from './util';

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function registerCurationTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('list_projects', {
    description: 'List ordinary projects accessible to the shared memory curator.',
  }, async () => {
    try {
      const projects = ctx.principal
        ? (await (await getAuthStore()).listAccessibleProjects(ctx.principal.userId))
          .map((project) => project.project_id)
        : (await ctx.svc.listProjects()).map((project) => project.id);
      return json(projects.filter((projectId) => projectId !== SHARED_PROJECT_ID)
        .map((projectId) => ({ project_id: projectId })));
    } catch {
      return toolError('curation project list is unavailable');
    }
  });

  server.registerTool('curation_snapshot', {
    description: 'Read paged active source memories or current shared targets for dated shared curation.',
    inputSchema: CurationSnapshotInput,
  }, async (input) => {
    try {
      const service = new CurationService(ctx.svc);
      if (input.view === 'targets') {
        await ctx.requireProjectAccess(SHARED_PROJECT_ID, 'read');
        return json(await service.targetSnapshot(input.after));
      }
      await ctx.requireProjectAccess(input.project_id, 'read');
      return json(await service.sourceSnapshot({
        project_id: input.project_id,
        after: input.after,
        ...(input.after ? {} : {
          window: {
            mode: input.mode ?? 'schedule',
            dry_run: input.dry_run,
            from_date: input.from_date,
            to_date: input.to_date,
          },
        }),
      }));
    } catch {
      return toolError('curation snapshot is unavailable for this project');
    }
  });

  server.registerTool('curation_apply', {
    description: 'Promote a hash- and citation-checked generalizable proposal to the shared project.',
    inputSchema: CurationApplyInput,
  }, async (input) => {
    try {
      await ctx.requireProjectAccess(SHARED_PROJECT_ID, 'maintain');
      if ('restore_request_id' in input) {
        return json(await applySharedRestore(input.restore_request_id, ctx.svc));
      }
      const { proposal } = input;
      const sourceIds = [...new Set(proposal.source_refs.map((ref) => ref.project_id))];
      for (const sourceProjectId of sourceIds) await ctx.requireProjectAccess(sourceProjectId, 'read');
      return json(await new CurationService(ctx.svc).applyProposal(proposal as SharedProposal));
    } catch {
      return toolError('curation proposal could not be applied');
    }
  });

  server.registerTool('curation_checkpoint', {
    description: 'Record outcomes for one validated source page or complete a fully processed run.',
    inputSchema: CurationCheckpointInput,
  }, async (input) => {
    try {
      await ctx.requireProjectAccess(SHARED_PROJECT_ID, 'maintain');
      if (input.action === 'restore_requests') {
        return json({ requests: await ctx.svc.curationStore.listRestoreRequests(input.limit) });
      }
      if (input.action === 'restore_result') {
        const request = await ctx.svc.curationStore.getRestoreRequest(input.request_id);
        if (!request || request.state === 'pending' || request.state !== input.state
          || request.failure_reason !== input.failure_reason) throw new Error('restore result is not recorded');
        return json({ request });
      }
      await ctx.requireProjectAccess(input.source_project_id, 'read');
      const service = new CurationService(ctx.svc);
      if (input.action === 'outcomes') {
        await service.recordOutcomes(input.source_project_id, input.run_id, input.page_index!, input.outcomes!);
        return json({ recorded: true });
      }
      return json(await service.complete(input.source_project_id, input.run_id));
    } catch {
      return toolError('curation checkpoint could not be recorded');
    }
  });
}
