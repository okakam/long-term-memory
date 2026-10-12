import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';

import { openDb } from '@/lib/db/connection';
import { computeHash } from '@/lib/markdown/file-io';
import { MemoryService } from '@/lib/memory/service';
import { DEFAULT_MAINTENANCE_SETTINGS } from '@/lib/maintenance/policy';
import { MaintenanceService } from '@/lib/maintenance/service';
import { resolveStorage } from '@/lib/paths';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join('/tmp', 'ltm-maintenance-proposal-'));
  roots.push(root);
  process.env.LTM_HOME = root;
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  const memories = MemoryService.open(db, storage);
  const maintenance = new MaintenanceService(memories, { now: () => '2026-10-12T00:00:00.000Z' });
  return { storage, db, memories, maintenance };
}

async function enable(memories: MemoryService) {
  return memories.maintenanceStore.saveSettings('project', {
    ...DEFAULT_MAINTENANCE_SETTINGS,
    enabled: true,
  }, 0);
}

function contentHash(storage: ReturnType<typeof resolveStorage>, name: string) {
  return computeHash(readFileSync(storage.memoryFile('project', name), 'utf8'));
}

test('rejects_forged_quotes_and_untrusted_proposal_fields', async () => {
  const { storage, db, memories, maintenance } = setup();
  try {
    const saved = memories.save('project', {
      name: 'verified-note', description: 'facts from a conversation', type: 'project', body: 'The release window is Friday.',
    });
    const settings = await enable(memories);
    const hash = contentHash(storage, saved.name);
    const forged = await maintenance.apply('project', {
      operation_id: 'forged-quote', settings_version: settings.version,
      expected_hashes: { [saved.id]: hash },
      action: { type: 'patch', memory_id: saved.id, patch: { body: 'The release window is Monday.' } },
      reason_code: 'confirmed',
      evidence: [{ memory_id: saved.id, content_hash: hash, start: 500, end: 530 }],
    });
    expect(forged.outcome).toBe('conflict');

    const injected = await maintenance.apply('project', {
      operation_id: 'injected-field', settings_version: settings.version,
      expected_hashes: { [saved.id]: hash },
      action: { type: 'review', memory_id: saved.id, review_state: 'confirmed', next_review_at: '1900-01-01T00:00:00.000Z' },
      reason_code: 'confirmed', evidence: [], source_url: 'https://attacker.invalid/?token=secret',
    });
    expect(injected.outcome).toBe('conflict');
    expect(memories.get('project', saved.id).body).toBe(saved.body);
    expect(await memories.listRevisionsAsync('project', saved.id)).toEqual([]);
  } finally { db.close(); }
});

test('rejects_new_facts_even_when_proposal_contains_a_real_quote', async () => {
  const { storage, db, memories, maintenance } = setup();
  try {
    const saved = memories.save('project', {
      name: 'grounded-note', description: 'a known fact', type: 'project', body: 'The release window is Friday.',
    });
    const settings = await enable(memories);
    const hash = contentHash(storage, saved.name);
    const result = await maintenance.apply('project', {
      operation_id: 'add-unsupported-claim', settings_version: settings.version,
      expected_hashes: { [saved.id]: hash },
      action: { type: 'patch', memory_id: saved.id, patch: { body: `${saved.body}\nDeploy at 09:00 UTC.` } },
      reason_code: 'confirmed', confidence: 0.99,
      evidence: [{ memory_id: saved.id, content_hash: hash, start: 0, end: saved.body.length }],
    });
    expect(result.outcome).toBe('conflict');
    expect(memories.get('project', saved.id).body).toBe(saved.body);
  } finally { db.close(); }
});

test('rejects_unrelated_citations_for_an_exact_duplicate_merge', async () => {
  const { storage, db, memories, maintenance } = setup();
  try {
    const body = 'The system stores timestamps in UTC.\nUnrelated note: the launch banner is blue.';
    const first = memories.save('project', {
      name: 'timestamp-rule-a', description: 'first copy', type: 'project', body,
    });
    const second = memories.save('project', {
      name: 'timestamp-rule-b', description: 'second copy', type: 'project', body,
    });
    const settings = await enable(memories);
    const firstHash = contentHash(storage, first.name);
    const secondHash = contentHash(storage, second.name);
    const unrelatedStart = body.indexOf('Unrelated');
    const unrelatedEnd = body.length;
    const result = await maintenance.apply('project', {
      operation_id: 'unrelated-merge-evidence', settings_version: settings.version,
      expected_hashes: { [first.id]: firstHash, [second.id]: secondHash },
      action: { type: 'merge', target_id: first.id, source_id: second.id, patch: { body } },
      reason_code: 'exact_duplicate',
      evidence: [
        { memory_id: first.id, content_hash: firstHash, start: unrelatedStart, end: unrelatedEnd },
        { memory_id: second.id, content_hash: secondHash, start: unrelatedStart, end: unrelatedEnd },
      ],
    });
    expect(result.outcome).toBe('conflict');
    expect(memories.get('project', first.id).status).toBe('active');
    expect(memories.get('project', second.id).status).toBe('active');
  } finally { db.close(); }
});

test('revalidates_source_citations_and_records_checked_hash', async () => {
  const { storage, db, memories } = setup();
  const sourceText = 'The current release window is Friday.';
  const sourceHash = createHash('sha256').update(sourceText, 'utf8').digest('hex');
  const fetchSource = vi.fn(async () => ({
    status: 'ok' as const,
    text: sourceText,
    content_hash: sourceHash,
    checked_at: '2026-10-12T00:00:00.000Z',
  }));
  const maintenance = new MaintenanceService(memories, {
    now: () => '2026-10-12T00:00:00.000Z',
    fetchSource,
  });
  try {
    const saved = memories.save('project', {
      name: 'release-source', description: 'current release details', type: 'reference',
      body: 'Release documentation.\nURL: https://docs.example.test/releases',
    });
    const settings = await enable(memories);
    const hash = contentHash(storage, saved.name);
    const baseProposal = {
      settings_version: settings.version,
      expected_hashes: { [saved.id]: hash },
      action: { type: 'patch' as const, memory_id: saved.id, patch: { body: sourceText } },
      reason_code: 'confirmed' as const,
      confidence: 0.99,
      evidence: [{
        memory_id: saved.id, content_hash: hash, start: 0, end: sourceText.length,
        source_index: 0, source_content_hash: '0'.repeat(64),
      }],
    };
    const unverified = await maintenance.apply('project', {
      operation_id: 'source-not-cited', settings_version: settings.version,
      expected_hashes: { [saved.id]: hash },
      action: { type: 'review', memory_id: saved.id, review_state: 'confirmed' },
      reason_code: 'confirmed', confidence: 0.99,
      evidence: [{ memory_id: saved.id, content_hash: hash, start: 0, end: saved.body.length }],
    });
    expect(unverified.outcome).toBe('conflict');
    expect(fetchSource).not.toHaveBeenCalled();

    const stale = await maintenance.apply('project', { ...baseProposal, operation_id: 'stale-source-result' });
    expect(stale.outcome).toBe('conflict');
    expect(memories.get('project', saved.id).body).toBe(saved.body);

    const validProposal = {
      ...baseProposal,
      operation_id: 'verified-source-result',
      evidence: [{ ...baseProposal.evidence[0]!, source_content_hash: sourceHash }],
    };
    const result = await maintenance.apply('project', validProposal);
    expect(result.outcome).toBe('applied');
    expect(fetchSource).toHaveBeenCalledWith('https://docs.example.test/releases');
    expect(memories.get('project', saved.id)).toMatchObject({
      body: sourceText,
      sources: [{ kind: 'url', content_hash: sourceHash, last_checked_at: '2026-10-12T00:00:00.000Z' }],
    });
    const replayed = await maintenance.apply('project', validProposal);
    expect(replayed.outcome).toBe('already_applied');
    expect(fetchSource).toHaveBeenCalledTimes(2);
    expect(await memories.listRevisionsAsync('project', saved.id)).toHaveLength(1);
  } finally { db.close(); }
});

test('ambiguous_reviews_retry_in_seven_days_and_fetch_failures_do_not_advance_review', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  const { storage, db, memories, maintenance } = setup();
  try {
    const saved = memories.save('project', {
      name: 'review-state', description: 'verify this source', type: 'reference', body: 'The source currently says version 4.',
    });
    const settings = await enable(memories);
    const originalHash = contentHash(storage, saved.name);
    const ambiguous = await maintenance.apply('project', {
      operation_id: 'ambiguous-review', settings_version: settings.version,
      expected_hashes: { [saved.id]: originalHash },
      action: { type: 'review', memory_id: saved.id, review_state: 'ambiguous' },
      reason_code: 'ambiguous',
      evidence: [{ memory_id: saved.id, content_hash: originalHash, start: 0, end: saved.body.length }],
    });
    expect(ambiguous.outcome).toBe('applied');
    const afterAmbiguous = memories.get('project', saved.id);
    expect(afterAmbiguous.last_reviewed_at).toBe('2026-10-12T00:00:00.000Z');
    expect(afterAmbiguous.next_review_at).toBe('2026-10-19T00:00:00.000Z');

    const currentHash = contentHash(storage, saved.name);
    const fetchFailed = await maintenance.apply('project', {
      operation_id: 'fetch-failed-review', settings_version: settings.version,
      expected_hashes: { [saved.id]: currentHash },
      action: { type: 'review', memory_id: saved.id, review_state: 'fetch_failed' },
      reason_code: 'fetch_failed', evidence: [],
    });
    expect(fetchFailed.outcome).toBe('applied');
    const afterFailure = memories.get('project', saved.id);
    expect(afterFailure.last_reviewed_at).toBe(afterAmbiguous.last_reviewed_at);
    expect(afterFailure.next_review_at).toBe('2026-10-19T00:00:00.000Z');
  } finally { db.close(); }
});
