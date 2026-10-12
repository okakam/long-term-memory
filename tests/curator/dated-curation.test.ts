import { expect, test, vi } from 'vitest';

import { runDatedCuration } from '../../scripts/curator/run-dated-curation';
import type { CurationPage, CurationWindow } from '../../src/lib/curation/types';
import type { Memory } from '../../src/lib/memory/types';

const window: CurationWindow = {
  from: null,
  to: '2026-10-12T01:00:00.000Z',
  mode: 'schedule',
  dry_run: false,
};

function memory(id: number, type: Memory['type'] = 'project', status: Memory['status'] = 'active'): Memory {
  return {
    id: `memory-${id}`,
    name: `memory-${id}`,
    description: 'Reusable memory',
    type,
    tags: [], links: [], entities: [], triples: [], supersedes: [],
    status,
    body: `Memory body ${id}`,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0', id: 'test', result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function sourcePage(
  records: Memory[],
  pageIndex: number,
  nextPage: string | null,
  pageWindow: CurationWindow = window,
): CurationPage {
  return {
    view: 'sources', run_id: '01J9C7Q4VY3E5M8H2N6K0P1RAB', source_project_id: 'alpha', window: pageWindow,
    page_index: pageIndex,
    memories: records.map((item) => ({ memory: item, content_hash: String(pageIndex).padStart(64, 'a') })),
    next_page: nextPage,
    complete: nextPage === null,
  };
}

function targetPage(after?: string): CurationPage {
  return {
    view: 'targets', run_id: 'targets', source_project_id: '__shared__',
    window: { from: null, to: '2026-10-12T00:00:00.000Z', mode: 'manual', dry_run: true },
    page_index: after ? 1 : 0,
    memories: [], next_page: after ? null : 'target-next', complete: Boolean(after),
  };
}

function fixture(
  sourcePages: CurationPage[],
  restoreRequests: Array<Record<string, unknown>> = [],
  completeAdvanced = true,
  restoreResultState: 'pending' | 'succeeded' = 'succeeded',
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let sourcePageIndex = 0;
  const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { params: { name: string; arguments: Record<string, unknown> } };
    const { name, arguments: args } = request.params;
    calls.push({ name, args });
    if (name === 'list_projects') return response([{ project_id: 'alpha' }]);
    if (name === 'curation_snapshot' && args.view === 'targets') return response(targetPage(args.after as string | undefined));
    if (name === 'curation_snapshot') return response(sourcePages[sourcePageIndex++]);
    if (name === 'curation_checkpoint' && args.action === 'restore_requests') return response({ requests: restoreRequests });
    if (name === 'curation_apply' && typeof args.restore_request_id === 'string') {
      const pending = restoreRequests.find((item) => item.id === args.restore_request_id);
      return response({ ...pending, state: restoreResultState, ...(restoreResultState === 'succeeded' ? { completed_at: '2026-10-12T01:00:00.000Z' } : {}) });
    }
    if (name === 'curation_checkpoint' && args.action === 'restore_result') {
      const request = restoreRequests.find((item) => item.id === args.request_id);
      return response({ request: { ...request, state: args.state, completed_at: '2026-10-12T01:00:00.000Z' } });
    }
    if (name === 'curation_checkpoint' && args.action === 'outcomes') return response({ recorded: true });
    if (name === 'curation_checkpoint' && args.action === 'complete') return response({ cursor: window.to, advanced: completeAdvanced });
    return new Response('unexpected tool', { status: 400 });
  });
  return { calls, fetcher };
}

test('pages all active memories across 500 and same-timestamp boundary and includes session', async () => {
  const records = Array.from({ length: 501 }, (_, index) => memory(index, index === 500 ? 'session' : 'project'));
  const pages: CurationPage[] = [];
  for (let offset = 0, pageIndex = 0; offset < records.length; offset += 25, pageIndex += 1) {
    const nextPage = offset + 25 < records.length ? `source-cursor-${pageIndex + 1}` : null;
    pages.push(sourcePage(records.slice(offset, offset + 25), pageIndex, nextPage));
  }
  const { calls, fetcher } = fixture(pages);
  const processedIds: string[] = [];
  const summary = await runDatedCuration({
    client: { baseUrl: 'https://ltm.example.test', bearerToken: 'curator-token', operationMode: 'curation', maintenanceToken: 'maintenance-token', fetcher },
    window,
    propose: async (page) => {
      processedIds.push(...page.memories.map((item) => item.memory.id));
      return [];
    },
  });

  expect(summary).toMatchObject({ scanned_projects: 1, failed: 0 });
  expect(processedIds).toHaveLength(501);
  expect(new Set(processedIds).size).toBe(501);
  expect(calls.filter((call) => call.name === 'curation_checkpoint' && call.args.action === 'outcomes')).toHaveLength(21);
  expect(calls.at(-1)).toMatchObject({ name: 'curation_checkpoint', args: { action: 'complete' } });
});

test('does not complete a scheduled cursor after a partial page failure', async () => {
  const pages = [
    sourcePage([memory(1)], 0, 'next-page'),
    sourcePage([memory(2)], 1, null),
  ];
  const { calls, fetcher } = fixture(pages);
  let pageCount = 0;
  const summary = await runDatedCuration({
    client: { baseUrl: 'https://ltm.example.test', bearerToken: 'curator-token', operationMode: 'curation', maintenanceToken: 'maintenance-token', fetcher },
    window,
    propose: async () => {
      pageCount += 1;
      if (pageCount === 2) throw new Error('private model output must not be logged');
      return [];
    },
  });

  expect(summary.failed).toBe(1);
  expect(calls.filter((call) => call.name === 'curation_checkpoint' && call.args.action === 'complete')).toHaveLength(0);
  expect(calls.filter((call) => call.name === 'curation_checkpoint' && call.args.action === 'outcomes')).toHaveLength(1);
});

test('dry run proposes without applying or recording checkpoints', async () => {
  const dryWindow: CurationWindow = { ...window, dry_run: true };
  const { calls, fetcher } = fixture([sourcePage([memory(1)], 0, null, dryWindow)]);
  const summary = await runDatedCuration({
    client: { baseUrl: 'https://ltm.example.test', bearerToken: 'curator-token', operationMode: 'curation', maintenanceToken: 'maintenance-token', fetcher },
    window: dryWindow,
    propose: async () => [],
  });

  expect(summary.failed).toBe(0);
  expect(calls.some((call) => call.name === 'curation_apply' || call.name === 'curation_checkpoint')).toBe(false);
});

test('ignores malformed model proposals without failing the source page', async () => {
  const { calls, fetcher } = fixture([sourcePage([memory(1)], 0, null)]);
  const summary = await runDatedCuration({
    client: { baseUrl: 'https://ltm.example.test', bearerToken: 'curator-token', operationMode: 'curation', maintenanceToken: 'maintenance-token', fetcher },
    window,
    propose: async () => [{ source_refs: null }],
  });

  expect(summary.failed).toBe(0);
  expect(calls.some((call) => call.name === 'curation_apply')).toBe(false);
  expect(calls.find((call) => call.name === 'curation_checkpoint' && call.args.action === 'outcomes')?.args.outcomes)
    .toEqual([{ source_memory_id: 'memory-1', outcome: 'no_op', reason_code: 'not_generalizable' }]);
});

test('manual write without dates accepts the server-resolved cursor window without advancing it', async () => {
  const manualWindow: CurationWindow = { ...window, from: null, mode: 'manual' };
  const resolvedWindow: CurationWindow = {
    ...manualWindow, from: '2026-10-05T00:00:00.000Z', to: '2026-10-12T01:00:02.000Z',
  };
  const { calls, fetcher } = fixture([sourcePage([], 0, null, resolvedWindow)], [], false);
  const summary = await runDatedCuration({
    client: { baseUrl: 'https://ltm.example.test', bearerToken: 'curator-token', operationMode: 'curation', maintenanceToken: 'maintenance-token', fetcher },
    window: manualWindow,
    propose: async () => [],
  });

  expect(summary.failed).toBe(0);
  expect(calls.find((call) => call.name === 'curation_snapshot' && call.args.view === 'sources')?.args)
    .toMatchObject({ mode: 'manual', dry_run: false });
  expect(calls.filter((call) => call.name === 'curation_checkpoint' && call.args.action === 'complete')).toHaveLength(1);
});

test('write run applies queued shared restore through curation gate and reports its result', async () => {
  const request = {
    id: '01J9C7Q4VY3E5M8H2N6K0P1RAB', memory_id: 'shared-memory-1', revision_id: 'revision-1',
    expected_hash: 'a'.repeat(64), requested_by: 'curator', state: 'pending', requested_at: '2026-10-12T00:00:00.000Z',
  };
  const { calls, fetcher } = fixture([sourcePage([], 0, null)], [request]);
  const summary = await runDatedCuration({
    client: { baseUrl: 'https://ltm.example.test', bearerToken: 'curator-token', operationMode: 'curation', maintenanceToken: 'maintenance-token', fetcher },
    window,
    propose: async () => [],
  });

  expect(summary.failed).toBe(0);
  expect(calls).toContainEqual({ name: 'curation_apply', args: { project_id: '__shared__', restore_request_id: request.id } });
  expect(calls).toContainEqual({ name: 'curation_checkpoint', args: {
    project_id: '__shared__', action: 'restore_result', request_id: request.id, state: 'succeeded',
  } });
});

test('write run leaves transiently unavailable restore requests pending for retry', async () => {
  const request = {
    id: '01J9C7Q4VY3E5M8H2N6K0P1RAB', memory_id: 'shared-memory-1', revision_id: 'revision-1',
    expected_hash: 'a'.repeat(64), requested_by: 'curator', state: 'pending', requested_at: '2026-10-12T00:00:00.000Z',
  };
  const { calls, fetcher } = fixture([sourcePage([], 0, null)], [request], true, 'pending');
  const summary = await runDatedCuration({
    client: { baseUrl: 'https://ltm.example.test', bearerToken: 'curator-token', operationMode: 'curation', maintenanceToken: 'maintenance-token', fetcher },
    window,
    propose: async () => [],
  });

  expect(summary.failed).toBe(0);
  expect(calls.some((call) => call.name === 'curation_checkpoint' && call.args.action === 'restore_result')).toBe(false);
  expect(calls.some((call) => call.name === 'curation_snapshot' && call.args.view === 'sources')).toBe(true);
});
