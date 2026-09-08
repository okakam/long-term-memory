import { MemoryNotFoundError, bodyChars, type Memory, type MemorySummary, MEMORY_TYPES } from '@/lib/memory/types';
import { rrfMerge } from '@/lib/memory/rrf';
import { SHARED_PROJECT_ID } from '@/lib/slug';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ToolContext } from '../context';
import {
  FindRelatedInput,
  GetMemoryIndexInput,
  GetMemoryInput,
  ListByTypeInput,
  SearchByTagInput,
  SearchMemoriesInput,
} from '../schemas';
import { json } from './util';

export const SHARED_SEARCH_CAP = 10;
export const SHARED_INDEX_CAP = 50;

type Scope = 'project' | 'shared';
type SupersededMap = Map<string, string>;

export interface ScopedMemorySummary extends MemorySummary {
  scope: Scope;
  superseded_by?: string;
}

export interface ScopedMemory extends Memory {
  scope: Scope;
  superseded_by?: string;
}

export function summarize(memory: Memory, scope: Scope, supersededBy?: SupersededMap): ScopedMemorySummary {
  const replacement = supersededBy?.get(memory.name);
  return {
    id: memory.id,
    name: memory.name,
    type: memory.type,
    description: memory.description,
    body_chars: bodyChars(memory.body),
    tags: memory.tags,
    links: memory.links,
    updated_at: memory.updated_at,
    scope,
    ...(replacement ? { superseded_by: replacement } : {}),
  };
}

export function tagSummary(summary: MemorySummary, scope: Scope, supersededBy?: SupersededMap): ScopedMemorySummary {
  const replacement = supersededBy?.get(summary.name);
  return {
    ...summary,
    scope,
    ...(replacement ? { superseded_by: replacement } : {}),
  };
}

export function concatByName<T extends { name: string }>(caller: T[], shared: T[]): T[] {
  const names = new Set(caller.map((item) => item.name));
  return [...caller, ...shared.filter((item) => !names.has(item.name))];
}

function includeShared(ctx: ToolContext, requested: boolean | undefined): boolean {
  return requested !== false && ctx.projectId !== SHARED_PROJECT_ID;
}

function scopeFor(projectId: string): Scope {
  return projectId === SHARED_PROJECT_ID ? 'shared' : 'project';
}

function isMemoryNotFound(error: unknown): boolean {
  return error instanceof MemoryNotFoundError
    || (error instanceof Error && error.name === 'MemoryNotFoundError');
}

async function scopedMap(ctx: ToolContext, projectId: string): Promise<SupersededMap> {
  return ctx.svc.supersededByMap(projectId);
}

const LIST_DESCRIPTION = 'List memories of a given type for the current project. `type` is the only required argument. Use it to load the highest-signal context for a task before starting: `feedback` for rules the user has already corrected you on, `project` for decisions in flight.';
const TAG_DESCRIPTION = 'Find memories matching the given tags (`any` = union, `all` = intersection). Precise and cheap when you already know the topic label — every tag shown by get_memory_index is a valid input, so this is the natural follow-up when several memories share a tag you care about.';
const RELATED_DESCRIPTION = 'Walk the links graph from a memory you already have in hand (by name or id), up to depth 3. The natural follow-up to a search hit or get_memory: linked memories usually hold the constraints and gotchas the first one takes for granted.';
const SEARCH_DESCRIPTION = 'Recall memories by topic. `query` alone is enough — it keyword-searches name, description and body, with no preparation needed. Optionally add `query_entities` (canonical concept names from the query) to also run graph-based associative retrieval. Worth one call before non-trivial work on a topic you lack context on: get_memory_index lists one-line descriptions only, so the reasoning a memory carries is in its body, which only this tool and get_memory reach. A result carrying `superseded_by` has been replaced by the named memory — prefer that one.';
const GET_DESCRIPTION = 'Fetch a memory in full, including the body — the reasoning (`why`), the trigger conditions (`how_to_apply`) and any commands or paths. The index and search results carry the one-line description only, so read the body here before you act on what a memory says.';
const INDEX_DESCRIPTION = "Get a compact index of the current project's memories — names, one-line descriptions, tags, links and `body_chars`, but no bodies. Shared-scope entries are appended, labeled scope:'shared'. This is a table of contents, not the memories themselves: `body_chars` is how many characters of reasoning each entry is withholding, so fetch any entry relevant to the task with get_memory rather than acting on its description alone.";

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('list_memories_by_type', {
    description: LIST_DESCRIPTION,
    inputSchema: ListByTypeInput,
  }, async ({ type, limit, include_shared }) => {
    const projectItems = await ctx.svc.listSummaries(ctx.projectId, { type, limit: limit ?? 100 });
    const projectMap = await scopedMap(ctx, ctx.projectId);
    const project = projectItems.map((item) => tagSummary(item, scopeFor(ctx.projectId), projectMap));
    if (!includeShared(ctx, include_shared)) return json(project);
    const sharedMap = await scopedMap(ctx, SHARED_PROJECT_ID);
    const sharedItems = await ctx.svc.listSummaries(SHARED_PROJECT_ID, { type, limit: SHARED_INDEX_CAP });
    const shared = sharedItems.map((item) => tagSummary(item, 'shared', sharedMap));
    return json(concatByName(project, shared));
  });

  server.registerTool('search_by_tag', {
    description: TAG_DESCRIPTION,
    inputSchema: SearchByTagInput,
  }, async ({ tags, match, include_shared }) => {
    const projectMap = await scopedMap(ctx, ctx.projectId);
    const projectItems = await ctx.svc.searchByTagSummaries(ctx.projectId, tags, match ?? 'any');
    const project = projectItems.map((item) => tagSummary(item, scopeFor(ctx.projectId), projectMap));
    if (!includeShared(ctx, include_shared)) return json(project);
    const sharedMap = await scopedMap(ctx, SHARED_PROJECT_ID);
    const sharedItems = await ctx.svc.searchByTagSummaries(SHARED_PROJECT_ID, tags, match ?? 'any');
    const shared = sharedItems.slice(0, SHARED_INDEX_CAP).map((item) => tagSummary(item, 'shared', sharedMap));
    return json(concatByName(project, shared));
  });

  server.registerTool('find_related', {
    description: RELATED_DESCRIPTION,
    inputSchema: FindRelatedInput,
  }, async ({ id_or_name, depth, include_shared }) => {
    try {
      const result = await ctx.svc.findRelated(ctx.projectId, id_or_name, depth ?? 1);
      const projectMap = await scopedMap(ctx, ctx.projectId);
      return json({
        nodes: result.nodes.map((item) => summarize(item, scopeFor(ctx.projectId), projectMap)),
        truncated: result.truncated,
      });
    } catch (error) {
      if (!includeShared(ctx, include_shared) || !isMemoryNotFound(error)) throw error;
      const result = await ctx.svc.findRelated(SHARED_PROJECT_ID, id_or_name, depth ?? 1);
      const sharedMap = await scopedMap(ctx, SHARED_PROJECT_ID);
      return json({
        nodes: result.nodes.map((item) => summarize(item, 'shared', sharedMap)),
        truncated: result.truncated,
      });
    }
  });

  server.registerTool('search_memories', {
    description: SEARCH_DESCRIPTION,
    inputSchema: SearchMemoriesInput,
  }, async ({ query, type, tags, query_entities, include_shared }) => {
    const options = { type, tags, queryEntities: query_entities };
    const projectMap = await scopedMap(ctx, ctx.projectId);
    const projectItems = await ctx.svc.searchAssociative(ctx.projectId, query, options);
    const project = projectItems.map((item) => summarize(item, scopeFor(ctx.projectId), projectMap));
    if (!includeShared(ctx, include_shared)) return json(project);
    const sharedMap = await scopedMap(ctx, SHARED_PROJECT_ID);
    const sharedItems = await ctx.svc.searchAssociative(SHARED_PROJECT_ID, query, { ...options, limit: SHARED_SEARCH_CAP });
    const shared = sharedItems.slice(0, SHARED_SEARCH_CAP).map((item) => summarize(item, 'shared', sharedMap));
    return json(rrfMerge([project, shared], (item) => item.name));
  });

  server.registerTool('get_memory', {
    description: GET_DESCRIPTION,
    inputSchema: GetMemoryInput,
  }, async ({ id_or_name, include_shared }) => {
    try {
      const memory = await ctx.svc.get(ctx.projectId, id_or_name);
      return json({ ...memory, ...summarize(memory, scopeFor(ctx.projectId), await scopedMap(ctx, ctx.projectId)) });
    } catch (error) {
      if (!includeShared(ctx, include_shared) || !isMemoryNotFound(error)) throw error;
      const memory = await ctx.svc.get(SHARED_PROJECT_ID, id_or_name);
      return json({ ...memory, ...summarize(memory, 'shared', await scopedMap(ctx, SHARED_PROJECT_ID)) });
    }
  });

  server.registerTool('get_memory_index', {
    description: INDEX_DESCRIPTION,
    inputSchema: GetMemoryIndexInput,
  }, async ({ include_shared }) => {
    const projectMap = await scopedMap(ctx, ctx.projectId);
    const project = (await Promise.all(MEMORY_TYPES.map((type) => ctx.svc.listSummaries(ctx.projectId, { type, limit: 500 })))).flat()
      .map((item) => tagSummary(item, scopeFor(ctx.projectId), projectMap));
    if (!includeShared(ctx, include_shared)) return json(project);
    const sharedMap = await scopedMap(ctx, SHARED_PROJECT_ID);
    const shared = (await Promise.all(MEMORY_TYPES.map((type) => ctx.svc.listSummaries(SHARED_PROJECT_ID, { type, limit: 500 })))).flat()
      .slice(0, SHARED_INDEX_CAP)
      .map((item) => tagSummary(item, 'shared', sharedMap));
    return json(concatByName(project, shared));
  });
}
