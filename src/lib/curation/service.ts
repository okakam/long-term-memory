import { createHash } from 'node:crypto';
import { ulid } from 'ulid';

import type { MemoryServiceLike } from '@/lib/memory/singleton';
import type { Memory, SourceRef } from '@/lib/memory/types';
import { SHARED_PROJECT_ID, assertProjectId } from '@/lib/slug';
import { decodeSourceAfter, encodeSourceAfter, readCurationPageToken, signCurationPageToken } from './cursor';
import type { CurationApplyResult, CurationOutcome, CurationPage, CurationWindow, SharedProposal } from './types';
import type { CurationWindowInput } from './window';
import { parseCurationWindow } from './window';

const PAGE_SIZE = 25;
const PAGE_BYTES = 256 * 1024;
const SHARED_CAP = 40;
type SourceStage = 'deferred' | 'window';

function encodeStageCursor(stage: SourceStage, cursor: string | null): string {
  return Buffer.from(JSON.stringify({ stage, cursor }), 'utf8').toString('base64url');
}

function decodeStageCursor(value: string): { stage: SourceStage; cursor: string | null } {
  if (value.length > 4096) throw new Error('invalid curation stage cursor');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error();
    const cursor = parsed as { stage?: unknown; cursor?: unknown };
    if ((cursor.stage !== 'deferred' && cursor.stage !== 'window')
      || (cursor.cursor !== null && typeof cursor.cursor !== 'string')) throw new Error();
    return { stage: cursor.stage, cursor: cursor.cursor };
  } catch {
    throw new Error('invalid curation stage cursor');
  }
}

function pageJsonBytes(memories: CurationPage['memories']): number {
  return Buffer.byteLength(JSON.stringify(memories), 'utf8');
}

function pageHash(memories: CurationPage['memories']): string {
  return createHash('sha256').update(JSON.stringify(memories.map(({ memory, content_hash }) => [memory.id, content_hash])))
    .digest('hex');
}

function normalizedBody(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('und');
}

function safeToShare(value: string): boolean {
  return !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value)
    && !/\b(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/.test(value)
    && !/\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S+/i.test(value)
    && !/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value);
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = key(value).normalize('NFKC').toLocaleLowerCase('und');
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function conflictingTriples(left: Memory['triples'], right: Memory['triples']): boolean {
  const relations = new Map<string, string>();
  for (const [subject, predicate, object] of [...left, ...right]) {
    const key = `${normalizedBody(subject)}\n${normalizedBody(predicate)}`;
    const previous = relations.get(key);
    if (previous !== undefined && previous !== normalizedBody(object)) return true;
    relations.set(key, normalizedBody(object));
  }
  return false;
}

function sortedSourceRefs(proposal: SharedProposal): SharedProposal['source_refs'] {
  return [...proposal.source_refs].sort((left, right) => left.project_id.localeCompare(right.project_id)
    || left.memory_id.localeCompare(right.memory_id));
}

function stableProposalHash(proposal: SharedProposal): string {
  const stable = {
    confidence: proposal.confidence,
    target_memory_id: proposal.target_memory_id ?? null,
    expected_target_hash: proposal.expected_target_hash ?? null,
    source_refs: sortedSourceRefs(proposal),
    evidence: [...proposal.evidence].sort((left, right) => left.project_id.localeCompare(right.project_id)
      || left.memory_id.localeCompare(right.memory_id) || left.start - right.start || left.end - right.end),
    memory: proposal.memory,
    reason_code: proposal.reason_code,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export class CurationService {
  constructor(
    private readonly source: MemoryServiceLike,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async sourceSnapshot(input: {
    project_id: string;
    window?: CurationWindowInput;
    after?: string;
  }): Promise<CurationPage> {
    const projectId = assertProjectId(input.project_id);
    if (projectId === SHARED_PROJECT_ID) throw new Error('shared scope cannot be a curation source');
    const now = this.now();
    let runId: string;
    let pageIndex: number;
    let window: CurationWindow;
    let manifestAfter: string | null;
    let stage: SourceStage;
    let stageAfter: string | null;
    if (input.after) {
      const cursor = readCurationPageToken(input.after);
      if (cursor.view !== 'sources' || cursor.project_id !== projectId) throw new Error('curation page token scope mismatch');
      runId = cursor.run_id;
      pageIndex = cursor.page_index;
      manifestAfter = cursor.after;
      const stageCursor = decodeStageCursor(cursor.after ?? '');
      stage = stageCursor.stage;
      stageAfter = stageCursor.cursor;
      if (cursor.stage !== stage) throw new Error('curation page token stage mismatch');
      if (cursor.window) {
        if (!cursor.window.dry_run || stage !== 'window') throw new Error('curation page token is malformed');
        window = cursor.window;
        if (!cursor.previous_hash || cursor.previous_limit === undefined || cursor.previous_after === undefined) {
          throw new Error('curation page token is incomplete');
        }
        const previous = await this.source.listCurationMemories(
          projectId, window, decodeSourceAfter(cursor.previous_after), cursor.previous_limit,
        );
        if (pageHash(previous.items) !== cursor.previous_hash) throw new Error('curation dry-run snapshot changed');
      } else {
        const run = await this.source.curationStore.getRun(runId);
        if (!run || run.source_project_id !== projectId) throw new Error('curation run is unavailable');
        window = run.window;
        const previous = await this.source.curationStore.getPage(runId, pageIndex - 1);
        if (pageIndex < 1 || !previous || previous.snapshot_complete || previous.next_after !== manifestAfter) {
          throw new Error('curation page token is stale');
        }
      }
    } else {
      const requested = parseCurationWindow(input.window ?? { mode: 'schedule', dry_run: false }, now);
      if (requested.dry_run) {
        runId = ulid();
        pageIndex = 0;
        const cursor = requested.from === null ? await this.source.curationStore.getCursor(projectId) : null;
        window = cursor === null ? requested : { ...requested, from: cursor };
        if (window.from !== null && window.from >= window.to) throw new Error('curation window must be non-empty');
      } else {
        const run = await this.source.curationStore.begin(projectId, requested, now);
        runId = run.run_id;
        pageIndex = 0;
        window = run.window;
      }
      manifestAfter = null;
      stageAfter = null;
      stage = 'window';
      if (!window.dry_run && window.mode === 'schedule'
        && (await this.source.curationStore.listDeferred(projectId, undefined, 1)).length > 0) stage = 'deferred';
    }

    let limit = PAGE_SIZE;
    let memories: CurationPage['memories'];
    let nextStage: SourceStage = 'window';
    let nextStageAfter: string | null = null;
    let complete: boolean;
    if (stage === 'deferred') {
      const deferred = await this.source.curationStore.listDeferred(projectId, stageAfter ?? undefined, PAGE_SIZE + 1);
      const selected = deferred.slice(0, PAGE_SIZE);
      const resolved = await Promise.all(selected.map(async (candidate) => {
        const current = await this.source.getMaintenanceMemory(projectId, candidate.source_memory_id);
        if (!current || (current.memory.status ?? 'active') !== 'active') {
          await this.source.curationStore.deleteDeferred(projectId, candidate.source_memory_id);
          return null;
        }
        return { memory: current.memory, content_hash: current.content_hash };
      }));
      memories = resolved.filter((item): item is NonNullable<typeof item> => item !== null);
      const hasMoreDeferred = deferred.length > PAGE_SIZE;
      if (hasMoreDeferred) {
        nextStage = 'deferred';
        nextStageAfter = selected.at(-1)?.source_memory_id ?? stageAfter;
      } else {
        nextStage = 'window';
      }
      complete = false;
    } else {
      let sourcePage = await this.source.listCurationMemories(projectId, window, decodeSourceAfter(stageAfter), limit);
      let nextMemoryAfter = encodeSourceAfter(sourcePage.next_after);
      while (pageJsonBytes(sourcePage.items) > PAGE_BYTES && sourcePage.items.length > 1) {
        limit = Math.max(1, Math.floor(limit / 2));
        sourcePage = await this.source.listCurationMemories(projectId, window, decodeSourceAfter(stageAfter), limit);
        nextMemoryAfter = encodeSourceAfter(sourcePage.next_after);
      }
      if (pageJsonBytes(sourcePage.items) > PAGE_BYTES) throw new Error('curation memory exceeds page size limit');
      memories = sourcePage.items;
      nextStage = 'window';
      nextStageAfter = nextMemoryAfter;
      complete = nextMemoryAfter === null;
    }
    if (pageJsonBytes(memories) > PAGE_BYTES) throw new Error('curation memory exceeds page size limit');
    const nextAfter = complete ? null : encodeStageCursor(nextStage, nextStageAfter);
    const page: CurationPage = {
      view: 'sources',
      run_id: runId,
      source_project_id: projectId,
      window,
      page_index: pageIndex,
      memories,
      next_page: complete ? null : signCurationPageToken({
        version: 1, view: 'sources', project_id: projectId, run_id: runId,
        page_index: pageIndex + 1, after: nextAfter,
        stage: nextStage,
        ...(window.dry_run ? {
          previous_after: stageAfter,
          previous_limit: limit,
          previous_hash: pageHash(memories),
        } : {}),
        ...(window.dry_run ? { window } : {}),
      }),
      complete,
    };
    if (!window.dry_run) {
      await this.source.curationStore.savePage(runId, {
        page_index: pageIndex,
        after: manifestAfter,
        next_after: nextAfter,
        snapshot_complete: complete,
        items: page.memories.map(({ memory, content_hash }) => ({ memory_id: memory.id, content_hash })),
      });
    }
    return page;
  }

  async targetSnapshot(after?: string): Promise<CurationPage> {
    const now = this.now();
    let pageIndex = 0;
    let afterId: string | undefined;
    if (after) {
      const cursor = readCurationPageToken(after);
      if (cursor.view !== 'targets' || cursor.project_id !== SHARED_PROJECT_ID) throw new Error('curation target cursor scope mismatch');
      pageIndex = cursor.page_index;
      if (typeof cursor.after !== 'string') throw new Error('curation target cursor is malformed');
      afterId = cursor.after;
    }
    let limit = PAGE_SIZE;
    let page = await this.source.listMaintenanceMemories(SHARED_PROJECT_ID, afterId, limit);
    let memories = page.items.map(({ memory, content_hash }) => ({ memory, content_hash }));
    while (pageJsonBytes(memories) > PAGE_BYTES && page.items.length > 1) {
      limit = Math.max(1, Math.floor(limit / 2));
      page = await this.source.listMaintenanceMemories(SHARED_PROJECT_ID, afterId, limit);
      memories = page.items.map(({ memory, content_hash }) => ({ memory, content_hash }));
    }
    if (pageJsonBytes(memories) > PAGE_BYTES) throw new Error('shared curation target page exceeds size limit');
    return {
      view: 'targets',
      run_id: 'targets',
      source_project_id: SHARED_PROJECT_ID,
      window: { from: null, to: now, mode: 'manual', dry_run: true },
      page_index: pageIndex,
      memories,
      next_page: page.next_after === null ? null : signCurationPageToken({
        version: 1, view: 'targets', project_id: SHARED_PROJECT_ID, run_id: 'targets',
        page_index: pageIndex + 1, after: page.next_after,
      }),
      complete: page.next_after === null,
    };
  }

  async recordOutcomes(sourceProjectId: string, runId: string, pageIndex: number, outcomes: CurationOutcome[]): Promise<void> {
    const run = await this.source.curationStore.getRun(runId);
    if (!run || run.source_project_id !== assertProjectId(sourceProjectId) || run.window.dry_run) {
      throw new Error('curation run is unavailable');
    }
    await this.source.curationStore.recordOutcomes(runId, pageIndex, outcomes);
    const now = this.now();
    for (const outcome of outcomes) {
      if (outcome.outcome === 'skipped' && outcome.reason_code === 'apply_conflict') {
        const current = await this.source.getMaintenanceMemory(sourceProjectId, outcome.source_memory_id);
        if (current && (current.memory.status ?? 'active') === 'active') {
          await this.source.curationStore.saveDeferred({
            source_project_id: sourceProjectId,
            source_memory_id: outcome.source_memory_id,
            content_hash: current.content_hash,
            reason_code: 'apply_conflict',
            created_at: now,
            updated_at: now,
          });
        } else {
          await this.source.curationStore.deleteDeferred(sourceProjectId, outcome.source_memory_id);
        }
        continue;
      }
      const remainsDeferred = outcome.outcome === 'skipped' && outcome.reason_code === 'shared_cap';
      if (!remainsDeferred) await this.source.curationStore.deleteDeferred(sourceProjectId, outcome.source_memory_id);
    }
  }

  async complete(sourceProjectId: string, runId: string): Promise<{ cursor: string | null; advanced: boolean }> {
    const run = await this.source.curationStore.getRun(runId);
    if (!run || run.source_project_id !== assertProjectId(sourceProjectId) || run.window.dry_run) {
      throw new Error('curation run is unavailable');
    }
    return this.source.curationStore.complete(runId, this.now());
  }

  async applyProposal(proposal: SharedProposal): Promise<CurationApplyResult> {
    const run = await this.source.curationStore.getRun(proposal.run_id);
    const operationHash = stableProposalHash(proposal);
    const operationId = `cur-${operationHash}`;
    const conflict = (): CurationApplyResult => ({ outcome: 'conflict', operation_id: operationId });
    if (!run || run.window.dry_run || run.state !== 'running' || proposal.confidence < 0.9
      || proposal.source_refs.length === 0 || proposal.source_refs.length > 25) return conflict();
    const manifest = await this.source.curationStore.getPage(proposal.run_id, proposal.page_index);
    if (!manifest || !manifest.items.length) return conflict();

    const sourceById = new Map<string, Memory>();
    for (const ref of proposal.source_refs) {
      if (ref.project_id !== run.source_project_id) return conflict();
      const item = manifest.items.find((candidate) => candidate.memory_id === ref.memory_id
        && candidate.content_hash === ref.content_hash);
      if (!item) return conflict();
      const current = await this.source.getMaintenanceMemory(ref.project_id, ref.memory_id);
      if (!current || (current.memory.status ?? 'active') !== 'active' || current.content_hash !== ref.content_hash
        || current.memory.name !== ref.memory) return conflict();
      sourceById.set(ref.memory_id, current.memory);
    }

    const citations = new Set<string>();
    for (const evidence of proposal.evidence) {
      const memory = sourceById.get(evidence.memory_id);
      const reference = proposal.source_refs.find((ref) => ref.memory_id === evidence.memory_id);
      if (!memory || !reference || evidence.project_id !== reference.project_id
        || evidence.content_hash !== reference.content_hash || evidence.start < 0
        || evidence.end <= evidence.start || evidence.end > memory.body.length
        || !memory.body.slice(evidence.start, evidence.end).trim()) return conflict();
      citations.add(evidence.memory_id);
    }
    if (proposal.source_refs.some((ref) => !citations.has(ref.memory_id))) return conflict();

    const sourceText = JSON.stringify([...sourceById.values()]);
    const candidateText = JSON.stringify(proposal.memory);
    if (!safeToShare(sourceText) || !safeToShare(candidateText)) {
      for (const ref of proposal.source_refs) await this.source.curationStore.deleteDeferred(ref.project_id, ref.memory_id);
      return { outcome: 'no_op', operation_id: operationId };
    }

    const sourceRefs: SourceRef[] = proposal.source_refs.map((ref) => ({ project_id: ref.project_id, memory: ref.memory }));
    const shared = await this.source.listMaintenanceMemories(SHARED_PROJECT_ID, undefined, SHARED_CAP + 1);
    const exactTargets = shared.items.filter(({ memory }) => memory.type === proposal.memory.type
      && normalizedBody(memory.body) === normalizedBody(proposal.memory.body));
    if (exactTargets.length > 1) return conflict();
    let target = exactTargets[0] ?? null;
    if (target && proposal.target_memory_id && proposal.target_memory_id !== target.memory.id) return conflict();
    if (!target && proposal.target_memory_id) {
      const current = await this.source.getMaintenanceMemory(SHARED_PROJECT_ID, proposal.target_memory_id);
      if (!current || current.memory.status !== 'active' || current.content_hash !== proposal.expected_target_hash
        || current.memory.type !== proposal.memory.type) return conflict();
      target = current;
    } else if (target && proposal.target_memory_id && target.content_hash !== proposal.expected_target_hash) {
      const alreadyPromoted = normalizedBody(target.memory.body) === normalizedBody(proposal.memory.body)
        && proposal.source_refs.every((ref) => (target!.memory.source_refs ?? []).some((saved) =>
          saved.project_id === ref.project_id && saved.memory === ref.memory));
      if (alreadyPromoted) return { outcome: 'promoted', change: 'existing', shared_memory_id: target.memory.id, operation_id: operationId };
      return conflict();
    } else if (!target && proposal.expected_target_hash) return conflict();

    const now = this.now();
    const inputRefs = unique([...sourceRefs], (ref) => `${ref.project_id}\n${ref.memory}`);
    if (target) {
      const currentRefs = target.memory.source_refs ?? [];
      const mergedRefs = unique([...currentRefs, ...inputRefs], (ref) => `${ref.project_id}\n${ref.memory}`);
      if (conflictingTriples(target.memory.triples, proposal.memory.triples ?? [])) return { outcome: 'no_op', operation_id: operationId };
      const tags = unique([...target.memory.tags, ...(proposal.memory.tags ?? [])], (value) => value);
      const entities = unique([...target.memory.entities, ...(proposal.memory.entities ?? [])], (entity) => entity.name)
        .map((entity) => ({
          ...entity,
          aliases: unique([...entity.aliases, ...(proposal.memory.entities ?? [])
            .filter((candidate) => normalizedBody(candidate.name) === normalizedBody(entity.name))
            .flatMap((candidate) => candidate.aliases)], (alias) => alias),
        }));
      const triples = unique([...target.memory.triples, ...(proposal.memory.triples ?? [])], (triple) => triple.join('\n'));
      const supersedes = unique([...target.memory.supersedes, ...(proposal.memory.supersedes ?? [])], (value) => value);
      const bodyChangeNeeded = exactTargets.length === 0 && Boolean(proposal.target_memory_id)
        && normalizedBody(target.memory.body) !== normalizedBody(proposal.memory.body);
      const unchanged = !bodyChangeNeeded && JSON.stringify(mergedRefs) === JSON.stringify(currentRefs)
        && JSON.stringify(tags) === JSON.stringify(target.memory.tags)
        && JSON.stringify(entities) === JSON.stringify(target.memory.entities)
        && JSON.stringify(triples) === JSON.stringify(target.memory.triples)
        && JSON.stringify(supersedes) === JSON.stringify(target.memory.supersedes);
      if (unchanged) {
        for (const ref of proposal.source_refs) await this.source.curationStore.deleteDeferred(ref.project_id, ref.memory_id);
        return { outcome: 'no_op', change: 'existing', shared_memory_id: target.memory.id, operation_id: operationId };
      }
      const result = await this.source.applyMutationAsync({
        operation_id: operationId,
        idempotency_hash: operationHash,
        project_id: SHARED_PROJECT_ID,
        expected_hashes: { [target.memory.id]: target.content_hash },
        action: {
          type: 'patch', memory_id: target.memory.id,
          patch: {
            ...(exactTargets.length === 0 ? { body: proposal.memory.body, description: proposal.memory.description } : {}),
            tags, entities, triples, supersedes, source_refs: mergedRefs,
          },
        },
        reason_code: 'shared_promoted',
        now,
      });
      if (result.outcome === 'conflict') return conflict();
      for (const ref of proposal.source_refs) await this.source.curationStore.deleteDeferred(ref.project_id, ref.memory_id);
      return { outcome: 'promoted', change: 'updated', shared_memory_id: target.memory.id, operation_id: operationId };
    }

    if (shared.items.filter(({ memory }) => (memory.status ?? 'active') === 'active').length >= SHARED_CAP
      || shared.next_after !== null) {
      for (const ref of proposal.source_refs) await this.source.curationStore.saveDeferred({
        source_project_id: ref.project_id,
        source_memory_id: ref.memory_id,
        content_hash: ref.content_hash,
        reason_code: 'shared_cap',
        created_at: now,
        updated_at: now,
      });
      return { outcome: 'deferred', operation_id: operationId };
    }
    if (await this.source.maintenanceNameExists(SHARED_PROJECT_ID, proposal.memory.name)) return conflict();

    const result = await this.source.applyMutationAsync({
      operation_id: operationId,
      idempotency_hash: operationHash,
      project_id: SHARED_PROJECT_ID,
      expected_hashes: {},
      max_active_memories: SHARED_CAP,
      action: {
        type: 'create',
        input: { ...proposal.memory, links: [], source_refs: inputRefs },
      },
      reason_code: 'shared_promoted',
      now,
    });
    if (result.outcome === 'conflict') {
      for (const ref of proposal.source_refs) await this.source.curationStore.saveDeferred({
        source_project_id: ref.project_id,
        source_memory_id: ref.memory_id,
        content_hash: ref.content_hash,
        reason_code: 'shared_cap',
        created_at: now,
        updated_at: now,
      });
      return { outcome: 'deferred', operation_id: operationId };
    }
    for (const ref of proposal.source_refs) await this.source.curationStore.deleteDeferred(ref.project_id, ref.memory_id);
    return { outcome: 'promoted', change: 'created', shared_memory_id: result.memory_ids[0], operation_id: operationId };
  }
}
