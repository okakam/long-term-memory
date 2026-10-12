import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';

import { openDb } from '@/lib/db/connection';
import { computeHash } from '@/lib/markdown/file-io';
import { MemoryService } from '@/lib/memory/service';
import { CurationService } from '@/lib/curation/service';
import type { SharedProposal } from '@/lib/curation/types';
import { resolveStorage } from '@/lib/paths';

const roots: string[] = [];
const services: MemoryService[] = [];
const ENV_KEYS = ['LTM_HOME', 'LTM_MAINTENANCE_TOKEN'];
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function fixture() {
  const root = mkdtempSync('/tmp/ltm-curation-upsert-');
  roots.push(root);
  process.env.LTM_HOME = root;
  process.env.LTM_MAINTENANCE_TOKEN = 'shared-maintenance-secret';
  const storage = resolveStorage();
  const db: Database.Database = openDb(storage.indexDb);
  const service = MemoryService.open(db, storage);
  services.push(service);
  return { service, storage };
}

async function proposalFor(service: MemoryService, memoryName: string, target?: { id: string; hash: string }): Promise<SharedProposal> {
  const source = service.get('alpha', memoryName);
  const sourceHash = computeHash(readFileSync(resolveStorage().memoryFile('alpha', memoryName), 'utf8'));
  const curation = new CurationService(service, () => new Date(Date.now() + 60_000).toISOString());
  const page = await curation.sourceSnapshot({ project_id: 'alpha', window: { mode: 'schedule', dry_run: false } });
  return {
    operation_id: 'model-generated-id',
    run_id: page.run_id,
    page_index: page.page_index,
    confidence: 0.97,
    ...(target ? { target_memory_id: target.id, expected_target_hash: target.hash } : {}),
    source_refs: [{ project_id: 'alpha', memory_id: source.id, memory: source.name, content_hash: sourceHash }],
    evidence: [{ project_id: 'alpha', memory_id: source.id, content_hash: sourceHash, start: 0, end: source.body.length }],
    memory: {
      name: 'workspace-guideline',
      description: 'A reusable workspace guideline',
      type: 'reference',
      body: 'Shared guidance: keep workspace job inputs versioned.',
      tags: ['workspace'],
    },
    reason_code: 'generalizable',
  };
}

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('promotes only the cited active source and preserves source_refs without editing it', async () => {
  const { service } = fixture();
  const source = service.save('alpha', {
    name: 'job-input-guideline', description: 'Reusable guideline', type: 'reference',
    body: 'Shared guidance: keep workspace job inputs versioned.',
  });
  const candidate = await proposalFor(service, source.name);
  const curation = new CurationService(service, () => new Date(Date.now() + 60_000).toISOString());

  await expect(curation.applyProposal(candidate)).resolves.toMatchObject({ outcome: 'promoted' });
  expect(service.get('alpha', source.id)).toMatchObject({ status: 'active', body: source.body });
  const shared = service.get('__shared__', 'workspace-guideline');
  expect(shared.source_refs).toEqual([{ project_id: 'alpha', memory: source.name }]);
});

test('rejects archived or changed source after snapshot', async () => {
  const { service } = fixture();
  const source = service.save('alpha', {
    name: 'job-input-guideline', description: 'Reusable guideline', type: 'reference',
    body: 'Shared guidance: keep workspace job inputs versioned.',
  });
  const proposal = await proposalFor(service, source.name);
  service.update('alpha', source.name, { body: 'The source changed after the snapshot.' });
  const curation = new CurationService(service, () => new Date(Date.now() + 60_000).toISOString());
  await expect(curation.applyProposal(proposal)).resolves.toMatchObject({ outcome: 'conflict' });
  expect(service.listProjects().find((project) => project.id === '__shared__')?.count ?? 0).toBe(0);
});

test('shared cap defers new candidates and never calls permanent delete', async () => {
  const { service } = fixture();
  for (let index = 0; index < 40; index += 1) {
    service.save('__shared__', {
      name: `shared-memory-${index}`,
      description: `Shared memory ${index}`,
      type: 'reference',
      body: `Reusable shared information ${index}.`,
    });
  }
  const source = service.save('alpha', {
    name: 'job-input-guideline', description: 'Reusable guideline', type: 'reference',
    body: 'Shared guidance: keep workspace job inputs versioned.',
  });
  const candidate = await proposalFor(service, source.name);
  const forget = vi.spyOn(service, 'forget');
  const curation = new CurationService(service, () => new Date(Date.now() + 60_000).toISOString());

  await expect(curation.applyProposal(candidate)).resolves.toMatchObject({ outcome: 'deferred' });
  expect((await service.listMaintenanceMemories('__shared__', undefined, 500)).items).toHaveLength(40);
  expect(await service.curationStore.listDeferred('alpha')).toHaveLength(1);
  expect(forget).not.toHaveBeenCalled();

  service.forget('__shared__', 'shared-memory-0');
  forget.mockClear();
  const reconsidered = await proposalFor(service, source.name);
  await expect(new CurationService(service, () => new Date(Date.now() + 60_000).toISOString()).applyProposal(reconsidered))
    .resolves.toMatchObject({ outcome: 'promoted' });
  expect((await service.listMaintenanceMemories('__shared__', undefined, 500)).items).toHaveLength(40);
  expect(await service.curationStore.listDeferred('alpha')).toHaveLength(0);
  expect(forget).not.toHaveBeenCalled();
});

test('candidate secrets and identifiers are skipped before shared storage', async () => {
  const { service } = fixture();
  const source = service.save('alpha', {
    name: 'private-contact', description: 'Contact detail', type: 'reference',
    body: 'Reach the author at person@example.test for help.',
  });
  const candidate = await proposalFor(service, source.name);
  const curation = new CurationService(service, () => new Date(Date.now() + 60_000).toISOString());
  await expect(curation.applyProposal(candidate)).resolves.toMatchObject({ outcome: 'no_op' });
  expect(service.listProjects().find((project) => project.id === '__shared__')?.count ?? 0).toBe(0);
});

test('source structured fields are checked before shared storage', async () => {
  const { service } = fixture();
  const source = service.save('alpha', {
    name: 'structured-guideline', description: 'Reusable guideline', type: 'reference',
    body: 'Shared guidance: keep workspace job inputs versioned.',
    entities: [{ name: 'Maintainer', aliases: ['person@example.test'] }],
  });
  const candidate = await proposalFor(service, source.name);
  const curation = new CurationService(service, () => new Date(Date.now() + 60_000).toISOString());

  await expect(curation.applyProposal(candidate)).resolves.toMatchObject({ outcome: 'no_op' });
  expect(service.listProjects().find((project) => project.id === '__shared__')?.count ?? 0).toBe(0);
});

test('proposal structured fields are checked before shared storage', async () => {
  const { service } = fixture();
  const source = service.save('alpha', {
    name: 'structured-guideline', description: 'Reusable guideline', type: 'reference',
    body: 'Shared guidance: keep workspace job inputs versioned.',
  });
  const candidate = await proposalFor(service, source.name);
  candidate.memory = {
    ...candidate.memory,
    tags: ['workspace', 'access_token=private-value'],
    links: ['https://example.test/person@example.test'],
    entities: [
      { name: 'service', aliases: ['person@example.test'] },
      { name: 'api_key=private-value', aliases: [] },
    ],
    triples: [['service', 'uses', 'api_key=private-value']],
    supersedes: ['password=private-value'],
  };
  const curation = new CurationService(service, () => new Date(Date.now() + 60_000).toISOString());

  await expect(curation.applyProposal(candidate)).resolves.toMatchObject({ outcome: 'no_op' });
  expect(service.listProjects().find((project) => project.id === '__shared__')?.count ?? 0).toBe(0);
});
