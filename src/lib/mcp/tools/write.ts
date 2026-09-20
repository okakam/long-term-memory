import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { SHARED_PROJECT_ID } from '@/lib/slug';
import type { ToolContext } from '../context';
import {
  ForgetMemoryInput,
  LinkMemoriesInput,
  RememberFeedbackInput,
  RememberProjectFactInput,
  RememberReferenceInput,
  RememberSessionSummaryInput,
  RememberUserFactInput,
  UpdateMemoryInput,
} from '../schemas';
import { composeWhyHowBody } from './compose';
import { text } from './util';

export function assertSharedWritable(ctx: ToolContext): void {
  if (ctx.projectId === SHARED_PROJECT_ID && !ctx.canWriteShared) {
    throw new Error('shared scope is read-only from a project session; writes require a valid maintenance token');
  }
}

const USER_DESCRIPTION = 'Save a memory about the user (role, preferences, skills). Required arguments: `name`, `description`, `body`, `entities`. `entities` must be non-empty — extract the canonical concept names (plus aliases) the body is about, or the memory never becomes a graph node and associative recall cannot reach it. Also add `triples` [subject, predicate, object] for any relation the body states; subjects/objects must be canonical names listed in `entities`. When this memory replaces an earlier one, pass the old name in `supersedes` so recall demotes it instead of returning both.';
const FEEDBACK_DESCRIPTION = 'Save corrective feedback or a confirmed judgment call. Required arguments: `name`, `description`, `body`, `why`, `how_to_apply`, `entities` — a call missing any of them is rejected. `why` (the rationale) and `how_to_apply` (the trigger condition for a future session) are separate arguments, not something to fold into `body`: they are appended to it as `**Why:**` / `**How to apply:**` lines. `entities` must be non-empty — the canonical concept names (plus aliases) the body is about — or associative recall cannot reach the memory. Also add `triples` [subject, predicate, object] for any relation the body states; subjects/objects must be canonical names listed in `entities`. When this memory replaces an earlier one, pass the old name in `supersedes` so recall demotes it instead of returning both.';
const PROJECT_DESCRIPTION = 'Save a project decision, deadline, or in-flight motivation. Required arguments: `name`, `description`, `body`, `why`, `how_to_apply`, `entities` — a call missing any of them is rejected. `why` and `how_to_apply` are appended as `**Why:**` / `**How to apply:**` lines, and `entities` must be non-empty canonical concepts for associative recall. Also add `triples` for relations stated by the body, and pass the old name in `supersedes` when this replaces an earlier memory. A record of what got done — an implementation landing, a merged PR, a finished phase — belongs in `remember_session_summary` so it decays on schedule instead.';
const REFERENCE_DESCRIPTION = 'Save a pointer to an external resource (URL, dashboard, channel). Required arguments: `name`, `description`, `body`; put the link in `url` so it is appended to the body. Reference memories deliberately carry no `entities` / `triples` — they are pointers, not knowledge-graph facts, so use remember_project_fact when the substance is the finding rather than the link.';
const SESSION_DESCRIPTION = 'Save a summary of what was done in a session. Required arguments: `name`, `description`, `body`. Session memories carry no `entities` / `triples` and decay fastest in ranking (30-day half-life), so anything meant to outlive this work belongs in remember_project_fact or remember_feedback instead.';
const UPDATE_DESCRIPTION = 'Patch an existing memory (description, body, tags, links, entities, triples, supersedes). Every patch field is optional and overwrites wholesale — an omitted field is left untouched, a supplied one replaces the old value rather than merging into it. When you change `body`, re-supply `entities` (and `triples` where relations changed) so the knowledge graph stays in sync with the new text — omitting them leaves the old graph in place. There are no `why` / `how_to_apply` arguments here (unlike remember_feedback / remember_project_fact): to keep those sections on a patched body, write the `**Why:**` and `**How to apply:**` lines into `patch.body` yourself.';
const FORGET_DESCRIPTION = 'Permanently delete a memory — the markdown file and every index row go with it, there is no soft delete, tombstone or undo. Confirm with the user before calling. When the memory is merely out of date, prefer update_memory, or save the replacement with `supersedes: ["<old-name>"]` so the history survives.';
const LINK_DESCRIPTION = 'Add a related-link from one memory to another (directional: `src` → `dst`). The edge is walked by find_related and weighted in associative recall. `src` is a name or id and must already exist; `dst` must be a memory *name* (slug) — an id is rejected — but does not have to exist yet. Use it to connect a memory to prerequisites and gotchas discovered later — for "this replaced that", pass `supersedes` on the write instead.';

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('remember_user_fact', { description: USER_DESCRIPTION, inputSchema: RememberUserFactInput }, async (input) => {
    assertSharedWritable(ctx);
    const memory = await ctx.svc.saveAsync(ctx.projectId, { ...input, type: 'user' });
    return text(`saved user memory ${memory.name} (${memory.id})`);
  });
  server.registerTool('remember_reference', { description: REFERENCE_DESCRIPTION, inputSchema: RememberReferenceInput }, async ({ url, ...input }) => {
    assertSharedWritable(ctx);
    const body = url ? `${input.body.replace(/\n+$/, '')}\n\nURL: ${url}` : input.body;
    const memory = await ctx.svc.saveAsync(ctx.projectId, { ...input, body, type: 'reference' });
    return text(`saved reference memory ${memory.name} (${memory.id})`);
  });
  server.registerTool('remember_session_summary', { description: SESSION_DESCRIPTION, inputSchema: RememberSessionSummaryInput }, async (input) => {
    assertSharedWritable(ctx);
    const memory = await ctx.svc.saveAsync(ctx.projectId, { ...input, type: 'session' });
    return text(`saved session memory ${memory.name} (${memory.id})`);
  });
  server.registerTool('remember_feedback', { description: FEEDBACK_DESCRIPTION, inputSchema: RememberFeedbackInput }, async ({ why, how_to_apply, ...input }) => {
    assertSharedWritable(ctx);
    const memory = await ctx.svc.saveAsync(ctx.projectId, {
      ...input,
      body: composeWhyHowBody(input.body, why, how_to_apply),
      type: 'feedback',
    });
    return text(`saved feedback memory ${memory.name} (${memory.id})`);
  });
  server.registerTool('remember_project_fact', { description: PROJECT_DESCRIPTION, inputSchema: RememberProjectFactInput }, async ({ why, how_to_apply, ...input }) => {
    assertSharedWritable(ctx);
    const memory = await ctx.svc.saveAsync(ctx.projectId, {
      ...input,
      body: composeWhyHowBody(input.body, why, how_to_apply),
      type: 'project',
    });
    return text(`saved project memory ${memory.name} (${memory.id})`);
  });
  server.registerTool('update_memory', { description: UPDATE_DESCRIPTION, inputSchema: UpdateMemoryInput }, async ({ id_or_name, patch }) => {
    assertSharedWritable(ctx);
    const memory = await ctx.svc.updateAsync(ctx.projectId, id_or_name, patch);
    return text(`updated ${memory.name} (${memory.id})`);
  });
  server.registerTool('forget_memory', { description: FORGET_DESCRIPTION, inputSchema: ForgetMemoryInput }, async ({ id_or_name, reason }) => {
    assertSharedWritable(ctx);
    await ctx.svc.forgetAsync(ctx.projectId, id_or_name, reason);
    return text(`forgot ${id_or_name}`);
  });
  server.registerTool('link_memories', { description: LINK_DESCRIPTION, inputSchema: LinkMemoriesInput }, async ({ src, dst }) => {
    assertSharedWritable(ctx);
    await ctx.svc.linkMemoriesAsync(ctx.projectId, src, dst);
    return text(`linked ${src} -> ${dst}`);
  });
}
