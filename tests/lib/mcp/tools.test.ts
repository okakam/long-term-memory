import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import { migrateAuth } from '@/lib/auth/migrate';
import { createPat } from '@/lib/auth/pat';
import { AuthStore, resetAuthStoreForTests, setAuthStoreForTests } from '@/lib/auth/store';
import type { MemoryService } from '@/lib/memory/service';
import type { Memory } from '@/lib/memory/types';
import { LocalIndexStore } from '@/lib/storage/local-index';
import { resetSessionState } from '@/lib/mcp/session';
import { handleMcpRequest } from '@/lib/mcp/transport';
import {
  FindRelatedInput, ForgetMemoryInput, GetMemoryIndexInput, GetMemoryInput,
  LinkMemoriesInput, ListByTypeInput, ReindexInput, RememberFeedbackInput,
  RememberProjectFactInput, RememberReferenceInput, RememberSessionSummaryInput,
  RememberUserFactInput, SearchByTagInput, SearchMemoriesInput, UpdateMemoryInput,
} from '@/lib/mcp/schemas';

const saved: Memory = {
  id: '01HZZZZZZZZZZZZZZZZZZZZZZ',
  name: 'feedback-memory',
  description: 'desc',
  type: 'feedback',
  tags: ['rule'],
  links: [],
  entities: [{ name: 'TypeScript', aliases: [] }],
  triples: [],
  supersedes: [],
  body: 'body\n\n**Why:** reason\n**How to apply:** trigger',
  created_at: '2026-09-05T00:00:00.000Z',
  updated_at: '2026-09-05T00:00:00.000Z',
};

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    saveAsync: vi.fn(async (_project: string, input: unknown) => ({ ...saved, ...(input as object) })),
    updateAsync: vi.fn(async () => saved),
    forgetAsync: vi.fn(async () => undefined),
    linkMemoriesAsync: vi.fn(async () => saved),
    get: vi.fn(() => saved),
    listSummaries: vi.fn(() => []),
    searchByTagSummaries: vi.fn(() => []),
    searchAssociative: vi.fn(() => []),
    findRelated: vi.fn(() => ({ nodes: [saved], truncated: false })),
    supersededByMap: vi.fn(() => new Map()),
    listProjects: vi.fn(() => []),
    reindex: vi.fn(),
    ...overrides,
  } as unknown as MemoryService;
}

async function call(service: MemoryService, name: string, arguments_: object, project = 'project', mode: 'stateless' | 'local-session' = 'stateless') {
  const response = await handleMcpRequest(new Request('https://example.test/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project_id: project, ...arguments_ } } }),
  }), { mode, service });
  return response.json() as Promise<{ result: { content: Array<{ text: string }>; isError?: boolean } }> ;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await resetSessionState();
  await resetAuthStoreForTests();
});

test('15個のproject scoped toolはtop-level project_idを必須とする', () => {
  const schemas = [
    FindRelatedInput, ForgetMemoryInput, GetMemoryIndexInput, GetMemoryInput,
    LinkMemoriesInput, ListByTypeInput, ReindexInput, RememberFeedbackInput,
    RememberProjectFactInput, RememberReferenceInput, RememberSessionSummaryInput,
    RememberUserFactInput, SearchByTagInput, SearchMemoriesInput, UpdateMemoryInput,
  ];
  for (const schema of schemas) {
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path.join('.') === 'project_id')).toBe(true);
  }
});

test('project_idはslug又はshared scopeだけを許可する', () => {
  const missing = SearchMemoriesInput.safeParse({ query: 'oauth' });
  expect(missing.success).toBe(false);
  if (!missing.success) expect(missing.error.issues.some((issue) => issue.path.join('.') === 'project_id')).toBe(true);
  expect(SearchMemoriesInput.safeParse({ project_id: 'product-a', query: 'oauth' }).success).toBe(true);
  expect(SearchMemoriesInput.safeParse({ project_id: '__shared__', query: 'oauth' }).success).toBe(true);
  expect(SearchMemoriesInput.safeParse({ project_id: '../escape', query: 'oauth' }).success).toBe(false);
});

test('source_refsのproject_idだけでは保存先projectを指定できない', () => {
  const result = RememberProjectFactInput.safeParse({
    name: 'project-memory', description: 'desc', body: 'body',
    entities: [{ name: 'Project' }], why: 'reason', how_to_apply: 'trigger',
    source_refs: [{ project_id: 'source-project', memory: 'source-memory' }],
  });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.some((issue) => issue.path.join('.') === 'project_id')).toBe(true);
});

test('feedback/project write は Why/How を body に合成して保存する', async () => {
  const service = makeService();
  const feedback = await call(service, 'remember_feedback', {
    name: 'feedback-memory', description: 'desc', body: 'body\n',
    entities: [{ name: 'TypeScript' }, { name: 'Codex' }],
    triples: [['TypeScript', 'used-by', 'Codex']],
    why: 'reason', how_to_apply: 'trigger',
  });
  expect(feedback.result.content[0].text).toContain('saved feedback memory feedback-memory');
  expect((service.saveAsync as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
    type: 'feedback', body: 'body\n\n**Why:** reason\n**How to apply:** trigger',
    triples: [['TypeScript', 'used-by', 'Codex']],
  });
});

test('update_memory は triples を tuple のまま更新サービスへ渡す', async () => {
  const service = makeService();
  const response = await call(service, 'update_memory', {
    id_or_name: 'feedback-memory',
    patch: { triples: [['TypeScript', 'used-by', 'Codex']] },
  });

  expect(response.result.content[0].text).toContain('updated feedback-memory');
  expect(service.updateAsync).toHaveBeenCalledWith('project', 'feedback-memory', {
    triples: [['TypeScript', 'used-by', 'Codex']],
  });
});

test('memory triple は3つの非空文字列を要求する', async () => {
  const service = makeService();
  const base = {
    name: 'invalid-triple-memory', description: 'desc', body: 'body',
    entities: [{ name: 'TypeScript' }], why: 'reason', how_to_apply: 'trigger',
  };

  const shortTriple = await call(service, 'remember_project_fact', {
    ...base, triples: [['TypeScript', 'uses']],
  });
  const emptyElement = await call(service, 'remember_project_fact', {
    ...base, triples: [['TypeScript', '', 'Codex']],
  });

  expect(shortTriple.result.isError).toBe(true);
  expect(emptyElement.result.isError).toBe(true);
  expect(service.saveAsync).not.toHaveBeenCalled();
});

test('reference URL は末尾へ追記される', async () => {
  const service = makeService();
  await call(service, 'remember_reference', { name: 'reference-memory', description: 'desc', body: 'body\n\n', url: 'https://example.test/doc' });
  expect((service.saveAsync as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
    type: 'reference', body: 'body\n\nURL: https://example.test/doc',
  });
});

test('shared scope は maintenance gate 無しの write を拒否する', async () => {
  const service = makeService();
  const response = await call(service, 'remember_user_fact', {
    name: 'shared-memory', description: 'desc', body: 'body',
    entities: [{ name: 'Entity' }],
  }, '__shared__');
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toContain('shared scope is read-only');
  expect(service.saveAsync).not.toHaveBeenCalled();
});

test('get_memory は full body と project scope を text JSON で返す', async () => {
  const service = makeService();
  const response = await call(service, 'get_memory', { id_or_name: 'unused' });
  const value = JSON.parse(response.result.content[0].text);
  expect(value.body).toContain('**Why:** reason');
  expect(value.scope).toBe('project');
});

test('reindex は現在の project scope をサービスへ渡す', async () => {
  const service = makeService();
  await call(service, 'reindex', {});
  expect(service.reindex).toHaveBeenCalledWith('project');
});

test('同じ接続で alpha と beta の save/search が入力 project に分離される', async () => {
  const service = makeService();
  for (const project of ['alpha', 'beta']) {
    const save = await call(service, 'remember_session_summary', { name: `${project}-note`, description: 'desc', body: 'body' }, project, 'local-session');
    const search = await call(service, 'search_memories', { query: 'note', include_shared: false }, project, 'local-session');
    expect(save.result.isError).not.toBe(true);
    expect(search.result.isError).not.toBe(true);
  }
  expect((service.saveAsync as ReturnType<typeof vi.fn>).mock.calls.map(([project]) => project)).toEqual(['alpha', 'beta']);
  expect((service.searchAssociative as ReturnType<typeof vi.fn>).mock.calls.map(([project]) => project)).toEqual(['alpha', 'beta']);
});

test('未所属 project と member reindex は HTTP 200 の tool error になり service を呼ばない', async () => {
  vi.stubEnv('AUTH_REQUIRED', '1');
  const db = new Database(':memory:');
  try {
    const index = new LocalIndexStore(db);
    await migrateAuth(index);
    const store = new AuthStore(index);
    setAuthStoreForTests(store);
    await store.createProject('alpha', 'owner-1');
    await store.createProject('beta', 'owner-2');
    await store.addMember('alpha', 'member-1', 'member');
    const pat = await createPat('member-1', 'member');
    const service = makeService();
    const request = async (name: string, args: object) => {
      const response = await handleMcpRequest(new Request('https://example.test/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${pat.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } }),
      }), { mode: 'stateless', service });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ result: { isError?: boolean } }>;
    };
    expect((await request('search_memories', { project_id: 'beta', query: 'topic' })).result.isError).toBe(true);
    expect((await request('remember_session_summary', { project_id: 'beta', name: 'note', description: 'desc', body: 'body' })).result.isError).toBe(true);
    expect((await request('reindex', { project_id: 'alpha' })).result.isError).toBe(true);
    expect(service.searchAssociative).not.toHaveBeenCalled();
    expect(service.saveAsync).not.toHaveBeenCalled();
    expect(service.reindex).not.toHaveBeenCalled();
  } finally { db.close(); }
});

test('shared write は curator UID の PAT と maintenance header が揃うまで service を呼ばない', async () => {
  vi.stubEnv('AUTH_REQUIRED', '1');
  vi.stubEnv('LTM_CURATOR_USER_ID', 'curator-1');
  vi.stubEnv('LTM_MAINTENANCE_TOKEN', 'maintenance-secret');
  const db = new Database(':memory:');
  try {
    const index = new LocalIndexStore(db);
    await migrateAuth(index);
    setAuthStoreForTests(new AuthStore(index));
    const curator = await createPat('curator-1', 'curator');
    const other = await createPat('other-1', 'other');
    const service = makeService();
    const request = async (token: string, maintenance?: string) => {
      const response = await handleMcpRequest(new Request('https://example.test/api/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(maintenance ? { 'x-ltm-maintenance-token': maintenance } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'remember_session_summary',
          arguments: { project_id: '__shared__', name: 'shared-note', description: 'desc', body: 'body' },
        } }),
      }), { mode: 'stateless', service });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ result: { isError?: boolean } }>;
    };
    expect((await request(curator.token)).result.isError).toBe(true);
    expect((await request(other.token, 'maintenance-secret')).result.isError).toBe(true);
    expect(service.saveAsync).not.toHaveBeenCalled();
    expect((await request(curator.token, 'maintenance-secret')).result.isError).not.toBe(true);
    expect(service.saveAsync).toHaveBeenCalledOnce();
    expect((service.saveAsync as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('__shared__');
  } finally { db.close(); }
});
