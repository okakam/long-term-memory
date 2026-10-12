import { createHash } from 'node:crypto';
import type { Memory, MemorySource } from '@/lib/memory/types';
import { SHARED_PROJECT_ID, assertProjectId } from '@/lib/slug';
import {
  deriveLegacyReview,
  MISSING_LINK_GRACE_DAYS,
  reviewSchedule,
  retryReviewAt,
} from '@/lib/maintenance/policy';
import { MaintenanceProposalSchema, type MaintenanceEvidence, type MaintenanceProposal } from '@/lib/maintenance/proposal';
import { fetchPublicSource, type SourceFetchResult } from '@/lib/maintenance/source-fetcher';
import type {
  MaintenanceMemorySource,
  MaintenancePage,
  MutationAction,
  MutationResult,
} from '@/lib/maintenance/store';

export interface MaintenanceServiceOptions {
  now?: () => string;
  pageSize?: number;
  fetchSource?: (url: string) => Promise<SourceFetchResult>;
}
interface EvidenceText {
  evidence: MaintenanceEvidence;
  quote: string;
  source_check?: { source_index: number; checked_at: string; content_hash: string };
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function tokens(value: string): Set<string> {
  return new Set(value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function tooSimilar(left: string, right: string): boolean {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return false;
  const overlap = [...a].filter((item) => b.has(item)).length;
  return overlap / Math.max(a.size, b.size) >= 0.55;
}

function hasContradictoryFacts(left: Memory, right: Memory): boolean {
  for (const [subject, relation] of left.triples.map((item) => [item[0], item[1]] as const)) {
    const otherObjects = right.triples.filter((item) => item[0] === subject && item[1] === relation).map((item) => item[2]);
    if (otherObjects.some((object) => !left.triples.some((item) => item[0] === subject && item[1] === relation && item[2] === object))) return true;
  }

  const a = normalizeText(left.body);
  const b = normalizeText(right.body);
  const aNumbers = new Set(a.match(/\b\d+(?:\.\d+)?\b/gu) ?? []);
  const bNumbers = new Set(b.match(/\b\d+(?:\.\d+)?\b/gu) ?? []);
  if (aNumbers.size > 0 && bNumbers.size > 0
    && ![...aNumbers].some((number) => bNumbers.has(number)) && tooSimilar(a, b)) return true;

  const aUtc = /\butc\b/u.test(a);
  const bUtc = /\butc\b/u.test(b);
  const aLocal = /\blocal(?: time| timezone)?\b/u.test(a);
  const bLocal = /\blocal(?: time| timezone)?\b/u.test(b);
  if ((aUtc && bLocal) || (bUtc && aLocal)) return true;

  const negation = /\b(?:not|no|never|without|disabled|false)\b|(?:ない|ません|禁止|無効)/u;
  if (negation.test(a) !== negation.test(b) && tooSimilar(a, b)) return true;
  return false;
}

async function evidenceFor(
  evidence: MaintenanceEvidence[],
  records: Map<string, { memory: Memory; content_hash: string }>,
  fetchSource: (url: string) => Promise<SourceFetchResult>,
): Promise<EvidenceText[] | null> {
  const output: EvidenceText[] = [];
  for (const item of evidence) {
    const record = records.get(item.memory_id);
    if (!record || item.content_hash !== record.content_hash) return null;
    let text = record.memory.body;
    let source_check: EvidenceText['source_check'];
    if (item.source_index !== undefined) {
      const source = record.memory.sources?.[item.source_index];
      if (!source || source.kind !== 'url') return null;
      let fetched: SourceFetchResult;
      try { fetched = await fetchSource(source.url); } catch { return null; }
      if (fetched.status !== 'ok' || fetched.content_hash !== item.source_content_hash) return null;
      text = fetched.text;
      source_check = {
        source_index: item.source_index,
        checked_at: fetched.checked_at,
        content_hash: fetched.content_hash,
      };
    }
    if (item.end > text.length) return null;
    const quote = text.slice(item.start, item.end).trim();
    if (!quote) return null;
    output.push({ evidence: item, quote, source_check });
  }
  return output;
}

function citesEvery(evidence: EvidenceText[], ids: string[]): boolean {
  return ids.every((id) => evidence.some((item) => item.evidence.memory_id === id));
}

function hasEveryUrlSource(memory: Memory, evidence: EvidenceText[]): boolean {
  return (memory.sources ?? []).every((source, index) => source.kind !== 'url'
    || evidence.some((item) => item.evidence.memory_id === memory.id && item.evidence.source_index === index));
}

function sourceEvidence(evidence: EvidenceText[]): EvidenceText[] {
  return evidence.filter((item) => item.evidence.source_index !== undefined);
}

function groundedBody(body: string, evidence: EvidenceText[]): boolean {
  const proposedLines = body.split(/\r?\n/u).map(normalizeText).filter(Boolean);
  const quotedLines = evidence.flatMap((item) => item.quote.split(/\r?\n/u).map(normalizeText)).filter(Boolean);
  return proposedLines.length > 0 && proposedLines.every((line) => quotedLines.includes(line));
}

function union<T>(...arrays: Array<T[] | undefined>): T[] {
  const byValue = new Map<string, T>();
  for (const values of arrays) for (const value of values ?? []) byValue.set(JSON.stringify(value), value);
  return [...byValue.values()];
}

function mergeSources(left?: MemorySource[], right?: MemorySource[]): MemorySource[] {
  const result: MemorySource[] = [];
  const byUrl = new Map<string, number>();
  const conversations = new Set<string>();
  for (const source of [...(left ?? []), ...(right ?? [])]) {
    if (source.kind === 'conversation') {
      if (conversations.has(source.captured_at)) continue;
      conversations.add(source.captured_at);
      result.push(source);
      continue;
    }
    const previousIndex = byUrl.get(source.url);
    if (previousIndex === undefined) {
      byUrl.set(source.url, result.length);
      result.push(source);
      continue;
    }
    const previous = result[previousIndex];
    if (previous?.kind !== 'url') continue;
    const previousChecked = timestamp(previous.last_checked_at ?? '') ?? -1;
    const nextChecked = timestamp(source.last_checked_at ?? '') ?? -1;
    const latest = nextChecked > previousChecked ? source : previous;
    const earliestCapture = timestamp(previous.captured_at)! <= timestamp(source.captured_at)!
      ? previous.captured_at
      : source.captured_at;
    result[previousIndex] = {
      ...latest,
      captured_at: earliestCapture,
      ...(latest.last_checked_at === undefined ? {} : { last_checked_at: latest.last_checked_at }),
      ...(latest.content_hash === undefined ? {} : { content_hash: latest.content_hash }),
    };
  }
  return result;
}

function sourcesWithChecks(memory: Memory, evidence: EvidenceText[]): MemorySource[] | undefined {
  const checks = new Map<number, NonNullable<EvidenceText['source_check']>>();
  for (const item of evidence) {
    if (item.evidence.memory_id === memory.id && item.source_check) checks.set(item.source_check.source_index, item.source_check);
  }
  if (checks.size === 0 || !memory.sources) return memory.sources;
  return memory.sources.map((source, index) => {
    const check = checks.get(index);
    return source.kind === 'url' && check
      ? { ...source, last_checked_at: check.checked_at, content_hash: check.content_hash }
      : source;
  });
}

function mergeEntities(left: Memory['entities'], right: Memory['entities']): Memory['entities'] {
  const entities = new Map<string, Memory['entities'][number]>();
  for (const entity of [...left, ...right]) {
    const key = entity.name.normalize('NFKC').toLocaleLowerCase();
    const previous = entities.get(key);
    entities.set(key, previous ? { name: previous.name, aliases: union(previous.aliases, entity.aliases) } : entity);
  }
  return [...entities.values()];
}

function oldestFirst(left: Memory, right: Memory): [Memory, Memory] {
  const createdAtOrder = left.created_at.localeCompare(right.created_at);
  return createdAtOrder < 0 || (createdAtOrder === 0 && left.id.localeCompare(right.id) <= 0)
    ? [left, right]
    : [right, left];
}

function operationId(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'operation_id' in value
    && typeof (value as { operation_id: unknown }).operation_id === 'string') {
    return (value as { operation_id: string }).operation_id.slice(0, 128) || 'invalid-proposal';
  }
  return 'invalid-proposal';
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function proposalHash(proposal: MaintenanceProposal): string {
  return createHash('sha256').update(stableJson(proposal), 'utf8').digest('hex');
}

function conflict(operation_id: string): MutationResult {
  return { operation_id, outcome: 'conflict', memory_ids: [], revision_ids: [] };
}

function actionMemoryIds(action: MaintenanceProposal['action']): string[] {
  return action.type === 'merge' ? [...new Set([action.target_id, action.source_id])] : [action.memory_id];
}

function mergeableTriples(left: Memory, right: Memory): boolean {
  const seen = new Map<string, string>();
  for (const [subject, relation, object] of [...left.triples, ...right.triples]) {
    const key = `${subject}\0${relation}`;
    const previous = seen.get(key);
    if (previous !== undefined && previous !== object) return false;
    seen.set(key, object);
  }
  return true;
}

function archiveEvidenceIsClear(reason: string, evidence: EvidenceText[], now: string): boolean {
  const text = evidence.map((item) => item.quote).join('\n');
  const normalized = normalizeText(text);
  if (reason === 'completed') return /\b(?:complete(?:d)?|done|closed)\b|完了|終了済み/u.test(normalized);
  if (reason === 'superseded') return /\b(?:superseded|replaced by|obsolete)\b|置き換え|後継/u.test(normalized);
  if (reason === 'expired') {
    const nowMs = Date.parse(now);
    return text.split(/\r?\n/u).some((line) => {
      if (!/\b(?:expires?|expired|valid until|expiry)\b|期限/iu.test(line)) return false;
      const dates = line.match(/\b20\d{2}-\d{2}-\d{2}\b/gu) ?? [];
      return dates.some((date) => Date.parse(`${date}T23:59:59.999Z`) < nowMs);
    });
  }
  return false;
}

export class MaintenanceService {
  private readonly now: () => string;
  private readonly pageSize: number;
  private readonly fetchSource: (url: string) => Promise<SourceFetchResult>;

  constructor(private readonly source: MaintenanceMemorySource, options: MaintenanceServiceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.pageSize = Math.min(500, Math.max(1, Math.floor(options.pageSize ?? 100)));
    this.fetchSource = options.fetchSource ?? fetchPublicSource;
  }

  async snapshot(projectIdInput: string, nowInput: string, after?: string): Promise<MaintenancePage> {
    const projectId = assertProjectId(projectIdInput);
    if (projectId === SHARED_PROJECT_ID) throw new Error('shared project is excluded from ordinary maintenance');
    const now = new Date(nowInput);
    if (Number.isNaN(now.getTime())) throw new Error('maintenance timestamp must be valid');
    const nowIso = now.toISOString();
    const settings = await this.source.maintenanceStore.getSettings(projectId);
    if (!settings.enabled) throw new Error('maintenance is not enabled for this project');
    const page = await this.source.listMaintenanceMemories(projectId, after, this.pageSize);
    const memories: MaintenancePage['memories'] = [];

    for (const item of page.items) {
      const missingLinks: string[] = [];
      for (const name of new Set(item.memory.links)) {
        if (await this.source.maintenanceNameExists(projectId, name)) {
          await this.source.maintenanceStore.clearLinkObservation(projectId, item.memory.id, name);
          continue;
        }
        const observation = await this.source.maintenanceStore.observeLinkIfAbsent(projectId, item.memory.id, name, nowIso);
        const firstSeen = timestamp(observation.first_seen_at);
        if (firstSeen !== null && now.getTime() - firstSeen >= MISSING_LINK_GRACE_DAYS * 24 * 60 * 60 * 1000) missingLinks.push(name);
      }
      memories.push({
        memory: item.memory,
        content_hash: item.content_hash,
        due: Date.parse(deriveLegacyReview(item.memory, settings)) <= now.getTime(),
        missing_links: missingLinks,
      });
    }
    return { memories, settings_version: settings.version, next_page: page.next_after };
  }

  async apply(projectIdInput: string, proposalInput: unknown): Promise<MutationResult> {
    const projectId = assertProjectId(projectIdInput);
    const id = operationId(proposalInput);
    if (projectId === SHARED_PROJECT_ID) return conflict(id);
    const parsed = MaintenanceProposalSchema.safeParse(proposalInput);
    if (!parsed.success) return conflict(id);
    const proposal: MaintenanceProposal = parsed.data;
    const fingerprint = proposalHash(proposal);
    const previous = await this.source.maintenanceStore.checkOperation(projectId, proposal.operation_id, fingerprint);
    if (previous) return previous;
    if (proposal.action.type === 'merge' && proposal.action.target_id === proposal.action.source_id) {
      return conflict(proposal.operation_id);
    }
    const now = new Date(this.now());
    if (Number.isNaN(now.getTime())) return conflict(proposal.operation_id);
    const nowIso = now.toISOString();
    const settings = await this.source.maintenanceStore.getSettings(projectId);
    if (!settings.enabled || settings.version !== proposal.settings_version) return conflict(proposal.operation_id);

    const ids = actionMemoryIds(proposal.action);
    if (ids.length !== Object.keys(proposal.expected_hashes).length
      || ids.some((memoryId) => !Object.hasOwn(proposal.expected_hashes, memoryId))) return conflict(proposal.operation_id);
    const records = new Map<string, { memory: Memory; content_hash: string }>();
    for (const memoryId of ids) {
      const current = await this.source.getMaintenanceMemory(projectId, memoryId);
      if (!current || (current.memory.status ?? 'active') !== 'active'
        || proposal.expected_hashes[memoryId] !== current.content_hash) return conflict(proposal.operation_id);
      records.set(memoryId, current);
    }
    const evidence = await evidenceFor(proposal.evidence, records, this.fetchSource);
    if (!evidence || proposal.evidence.some((item) => !records.has(item.memory_id))) return conflict(proposal.operation_id);
    const memory = records.get(ids[0]!)!.memory;
    let action: MutationAction;

    switch (proposal.action.type) {
      case 'review': {
        if (proposal.reason_code !== proposal.action.review_state) return conflict(proposal.operation_id);
        if (proposal.action.review_state !== 'fetch_failed' && !citesEvery(evidence, [memory.id])) return conflict(proposal.operation_id);
        if (proposal.action.review_state === 'confirmed'
          && ((proposal.confidence ?? 0) < 0.9 || !hasEveryUrlSource(memory, evidence))) return conflict(proposal.operation_id);
        const nextReviewAt = proposal.action.review_state === 'confirmed'
          ? reviewSchedule(memory.type, nowIso, settings).next_review_at
          : retryReviewAt(nowIso);
        action = {
          type: 'review', memory_id: memory.id, review_state: proposal.action.review_state,
          next_review_at: nextReviewAt,
          sources: sourcesWithChecks(memory, evidence),
        };
        break;
      }
      case 'patch': {
        if (proposal.reason_code !== 'confirmed' || Object.keys(proposal.action.patch).some((key) => key !== 'body')
          || (proposal.confidence ?? 0) < 0.9 || !proposal.action.patch.body || !citesEvery(evidence, [memory.id])
          || !hasEveryUrlSource(memory, evidence)
          || !groundedBody(proposal.action.patch.body, memory.sources?.some((source) => source.kind === 'url')
            ? sourceEvidence(evidence)
            : evidence)) return conflict(proposal.operation_id);
        action = {
          type: 'patch', memory_id: memory.id, patch: { body: proposal.action.patch.body },
          sources: sourcesWithChecks(memory, evidence),
        };
        break;
      }
      case 'archive': {
        const reason = proposal.action.archive_reason;
        if (proposal.reason_code !== reason || !citesEvery(evidence, [memory.id])) return conflict(proposal.operation_id);
        if (reason === 'session_aged') {
          if (memory.type !== 'session' || Date.parse(deriveLegacyReview(memory, settings)) > now.getTime()) return conflict(proposal.operation_id);
        } else if (!archiveEvidenceIsClear(reason, evidence, nowIso)) return conflict(proposal.operation_id);
        action = { type: 'archive', memory_id: memory.id, archive_reason: reason };
        break;
      }
      case 'merge': {
        const left = records.get(proposal.action.target_id)!.memory;
        const right = records.get(proposal.action.source_id)!.memory;
        if (left.type !== right.type || !citesEvery(evidence, [left.id, right.id])
          || Object.keys(proposal.action.patch).some((key) => key !== 'body')
          || !mergeableTriples(left, right) || hasContradictoryFacts(left, right)) return conflict(proposal.operation_id);
        const exact = normalizeText(left.body) === normalizeText(right.body);
        if (exact !== (proposal.reason_code === 'exact_duplicate')) return conflict(proposal.operation_id);
        if (!exact && (proposal.reason_code !== 'semantic_duplicate' || (proposal.confidence ?? 0) < 0.9
          || !tooSimilar(left.body, right.body))) return conflict(proposal.operation_id);
        const [target, source] = oldestFirst(left, right);
        if (exact && [left.id, right.id].some((memoryId) => {
          const record = records.get(memoryId)!;
          const citation = evidence.find((item) => item.evidence.memory_id === memoryId);
          return !citation || normalizeText(citation.quote) !== normalizeText(record.memory.body);
        })) return conflict(proposal.operation_id);
        const outputBody = exact ? target.body : proposal.action.patch.body;
        if (!outputBody || (exact && normalizeText(outputBody) !== normalizeText(target.body))
          || (!exact && !groundedBody(outputBody, evidence))) return conflict(proposal.operation_id);
        const sourceRefs = union(target.source_refs, source.source_refs);
        const patch = {
          body: outputBody,
          tags: union(target.tags, source.tags),
          links: union(target.links, source.links),
          source_refs: sourceRefs.length > 0 ? sourceRefs : undefined,
          supersedes: union(target.supersedes, source.supersedes),
          entities: mergeEntities(target.entities, source.entities),
          triples: union(target.triples, source.triples),
        };
        action = {
          type: 'merge', target_id: target.id, source_id: source.id, patch,
          sources: mergeSources(sourcesWithChecks(target, evidence), sourcesWithChecks(source, evidence)),
          archive_reason: proposal.reason_code,
        };
        break;
      }
      case 'prune_links': {
        if (proposal.reason_code !== 'missing_link' || !citesEvery(evidence, [memory.id])) return conflict(proposal.operation_id);
        const uniqueNames = [...new Set(proposal.action.names)];
        for (const name of uniqueNames) {
          if (!memory.links.includes(name) || await this.source.maintenanceNameExists(projectId, name)) return conflict(proposal.operation_id);
          const observation = await this.source.maintenanceStore.getLinkObservation(projectId, memory.id, name);
          const firstSeen = observation ? timestamp(observation.first_seen_at) : null;
          if (firstSeen === null || now.getTime() - firstSeen < MISSING_LINK_GRACE_DAYS * 24 * 60 * 60 * 1000) return conflict(proposal.operation_id);
        }
        action = { type: 'prune_links', memory_id: memory.id, names: uniqueNames };
        break;
      }
    }

    const result = await this.source.applyMutationAsync({
      operation_id: proposal.operation_id,
      project_id: projectId,
      idempotency_hash: fingerprint,
      expected_hashes: proposal.expected_hashes,
      expected_settings_version: proposal.settings_version,
      action,
      reason_code: proposal.reason_code,
      now: nowIso,
    });
    if (result.outcome === 'applied' && action.type === 'prune_links') {
      await Promise.all(action.names.map((name) => this.source.maintenanceStore.clearLinkObservation(projectId, action.memory_id, name)));
    }
    return result;
  }

  async exactDuplicatePairs(projectIdInput: string): Promise<Array<{ older_id: string; newer_id: string }>> {
    const projectId = assertProjectId(projectIdInput);
    if (projectId === SHARED_PROJECT_ID) return [];
    const settings = await this.source.maintenanceStore.getSettings(projectId);
    if (!settings.enabled) return [];
    const all: Memory[] = [];
    let after: string | undefined;
    do {
      const page = await this.source.listMaintenanceMemories(projectId, after, this.pageSize);
      all.push(...page.items.map((item) => item.memory));
      after = page.next_after ?? undefined;
    } while (after);
    const groups = new Map<string, Memory[]>();
    for (const memory of all) {
      const key = `${memory.type}\0${normalizeText(memory.body)}`;
      groups.set(key, [...(groups.get(key) ?? []), memory]);
    }
    const pairs: Array<{ older_id: string; newer_id: string }> = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
      for (let index = 1; index < group.length; index += 1) pairs.push({ older_id: group[0]!.id, newer_id: group[index]!.id });
    }
    return pairs;
  }
}
