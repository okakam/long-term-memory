import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, vi } from 'vitest';

import { createClaudeProposer, runMaintenance, runMaintenanceAndReport, type MaintenanceRunnerOptions } from '../../scripts/curator/run-maintenance';
import type { MaintenanceProposal } from '../../src/lib/maintenance/proposal';
import type { SourceFetchResult } from '../../src/lib/maintenance/source-fetcher';

const body = 'This memory should be reviewed carefully.';
const memory = {
  id: 'memory-1', name: 'review-note', description: 'A review note', type: 'project' as const,
  tags: [], links: [], entities: [], triples: [], supersedes: [], body,
  sources: [{ kind: 'conversation' as const, captured_at: '2026-09-01T00:00:00.000Z' }],
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
};
const page = {
  memories: [{ memory, content_hash: 'a'.repeat(64), due: true, missing_links: [] }],
  settings_version: 3,
  next_page: null,
};

function response(value: unknown): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0', id: 'test', result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function fixture(projects: Array<{ project_id: string; settings_version: number }>) {
  const applyCalls: unknown[] = [];
  const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { params: { name: string; arguments: Record<string, unknown> } };
    if (request.params.name === 'maintenance_list_projects') return response(projects);
    if (request.params.name === 'maintenance_snapshot') {
      if (request.params.arguments.project_id === 'failed-project') return new Response('unavailable', { status: 503 });
      return response(page);
    }
    if (request.params.name === 'maintenance_apply') {
      applyCalls.push(request.params.arguments);
      return response({ outcome: 'applied' });
    }
    return new Response('unexpected tool', { status: 400 });
  });
  const proposal: MaintenanceProposal = {
    operation_id: 'review-memory-1', settings_version: 3,
    expected_hashes: { 'memory-1': 'a'.repeat(64) },
    action: { type: 'review', memory_id: 'memory-1', review_state: 'ambiguous' },
    reason_code: 'ambiguous',
    evidence: [{ memory_id: 'memory-1', content_hash: 'a'.repeat(64), start: 0, end: body.length }],
  };
  const options: MaintenanceRunnerOptions = {
    client: { baseUrl: 'https://ltm.example.test', bearerToken: 'ltm_auto_test', fetcher },
    dry_run: false,
    now: () => '2026-10-12T00:00:00.000Z',
    fetchSource: vi.fn(async (): Promise<SourceFetchResult> => ({ status: 'failed', reason_code: 'network_error', checked_at: '2026-10-12T00:00:00.000Z' })),
    propose: vi.fn(async () => [proposal]),
  };
  return { options, fetcher, applyCalls, proposal };
}

test('dry_run_has_no_mutations', async () => {
  const { options, applyCalls } = fixture([{ project_id: 'alpha', settings_version: 3 }]);
  options.dry_run = true;
  const summary = await runMaintenance(options);
  expect(summary).toEqual({ scanned_projects: 1, applied: 0, skipped: 1, failed: 0 });
  expect(applyCalls).toHaveLength(0);
});

test('project単位の失敗を集計し、他projectのproposal処理は続ける', async () => {
  const { options, applyCalls } = fixture([
    { project_id: 'alpha', settings_version: 3 },
    { project_id: 'failed-project', settings_version: 3 },
  ]);
  const summary = await runMaintenance(options);
  expect(summary.failed).toBe(1);
  expect(summary.applied).toBe(1);
  expect(applyCalls).toHaveLength(1);
});

test('stdout_contains_only_summary', async () => {
  const { options } = fixture([{ project_id: 'alpha', settings_version: 3 }]);
  const secretFixture = 'private-model-output-secret';
  options.propose = vi.fn(async () => { throw new Error(secretFixture); });
  const stdout: string[] = [];
  const summary = await runMaintenanceAndReport(options, (line) => stdout.push(line));
  expect(summary.failed).toBe(1);
  expect(stdout).toEqual([JSON.stringify(summary)]);
  expect(stdout.join('\n')).not.toContain(secretFixture);
});

test('Claudeのraw stdoutはparse errorにせず、consoleへ流さない', async () => {
  const root = mkdtempSync('/tmp/ltm-model-output-');
  const claude = join(root, 'claude');
  const secretFixture = 'private-model-output-secret';
  writeFileSync(claude, `#!/bin/sh\nprintf '%s' '${secretFixture}'\n`, { mode: 0o700 });
  chmodSync(claude, 0o700);
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await expect(createClaudeProposer(page, {}, claude)).rejects.toThrow('proposal unavailable');
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain(secretFixture);
  } finally {
    consoleSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
