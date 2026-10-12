import { createHash } from 'node:crypto';
import { ulid } from 'ulid';

import { MemorySchema, type Memory, type SaveInput, type UpdateInput } from '@/lib/memory/types';
import { reviewSchedule } from '@/lib/maintenance/policy';
import type { MaintenanceSettings } from '@/lib/maintenance/types';
import { sourcesFromBody } from '@/lib/markdown/frontmatter';
import type { MutationAction, MutationRequest } from '@/lib/maintenance/store';

export function mutationPayloadHash(request: MutationRequest): string {
  const stableRequest = {
    operation_id: request.operation_id,
    project_id: request.project_id,
    expected_hashes: request.expected_hashes,
    expected_settings_version: request.expected_settings_version,
    action: request.action,
    reason_code: request.reason_code,
  };
  return createHash('sha256').update(JSON.stringify(stableRequest)).digest('hex');
}

export function mutationMemoryIds(action: MutationAction): string[] {
  switch (action.type) {
    case 'create': return [];
    case 'merge': return [...new Set([action.target_id, action.source_id])];
    default: return [action.memory_id];
  }
}

function withPatch(current: Memory, patch: UpdateInput, now: string, settings: MaintenanceSettings): Memory {
  const body = patch.body ?? current.body;
  const contentChanged = (patch.body !== undefined && patch.body !== current.body)
    || (patch.description !== undefined && patch.description !== current.description);
  const review = contentChanged ? reviewSchedule(current.type, now, settings) : null;
  const sources = patch.body !== undefined && patch.body !== current.body
    ? (sourcesFromBody(body, now).length > 0 ? sourcesFromBody(body, now) : [{ kind: 'conversation' as const, captured_at: now }])
    : current.sources;
  return MemorySchema.parse({
    ...current,
    description: patch.description ?? current.description,
    body,
    tags: patch.tags ?? current.tags,
    links: patch.links ?? current.links,
    entities: patch.entities ?? current.entities,
    triples: patch.triples ?? current.triples,
    source_refs: patch.source_refs ?? current.source_refs,
    supersedes: patch.supersedes ?? current.supersedes,
    sources,
    last_reviewed_at: review?.last_reviewed_at ?? current.last_reviewed_at,
    next_review_at: review?.next_review_at ?? current.next_review_at,
    status: current.status ?? 'active',
    updated_at: now,
  });
}

function createMemory(input: SaveInput, now: string, settings: MaintenanceSettings): Memory {
  const urls = sourcesFromBody(input.body, now);
  return MemorySchema.parse({
    id: ulid(),
    name: input.name,
    description: input.description,
    type: input.type,
    tags: input.tags ?? [],
    links: input.links ?? [],
    entities: input.entities ?? [],
    triples: input.triples ?? [],
    source_refs: input.source_refs,
    sources: urls.length > 0 ? urls : [{ kind: 'conversation', captured_at: now }],
    supersedes: input.supersedes ?? [],
    body: input.body,
    created_at: now,
    updated_at: now,
    ...reviewSchedule(input.type, now, settings),
    status: 'active',
  });
}

function archive(memory: Memory, reason: string, now: string): Memory {
  return MemorySchema.parse({
    ...memory,
    status: 'archived',
    archived_at: now,
    archive_reason: reason,
    archived_by: 'automated-maintenance',
    updated_at: now,
  });
}

export function prepareMutation(
  request: MutationRequest,
  currentMemories: Map<string, Memory>,
  settings: MaintenanceSettings,
  restoredMemory?: Memory,
): Memory[] {
  const action = request.action;
  if (action.type === 'create') return [createMemory(action.input, request.now, settings)];
  if (action.type === 'merge') {
    const target = currentMemories.get(action.target_id);
    const source = currentMemories.get(action.source_id);
    if (!target || !source || target.id === source.id) throw new Error('merge target and source must exist and differ');
    return [withPatch(target, action.patch, request.now, settings), archive(source, 'merged', request.now)];
  }

  const current = currentMemories.get(action.memory_id);
  if (!current) throw new Error(`mutation memory not found: ${action.memory_id}`);
  switch (action.type) {
    case 'review': {
      return [MemorySchema.parse({
        ...current,
        ...(action.sources ? { sources: action.sources } : {}),
        ...(action.review_state === 'confirmed' ? { last_reviewed_at: request.now } : {}),
        next_review_at: action.next_review_at,
        updated_at: request.now,
      })];
    }
    case 'patch': return [withPatch(current, action.patch, request.now, settings)];
    case 'archive': return [archive(current, action.archive_reason, request.now)];
    case 'prune_links': {
      const removed = new Set(action.names);
      return [MemorySchema.parse({ ...current, links: current.links.filter((name) => !removed.has(name)), updated_at: request.now })];
    }
    case 'restore': {
      if (!restoredMemory) throw new Error('restore revision is unavailable');
      return [MemorySchema.parse({
        ...restoredMemory,
        id: current.id,
        name: current.name,
        created_at: current.created_at,
        updated_at: request.now,
        status: 'active',
        archived_at: undefined,
        archive_reason: undefined,
        archived_by: undefined,
      })];
    }
  }
}
