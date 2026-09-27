import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';

import type { MemoryService } from '@/lib/memory/service';
import { migrateAuth } from '@/lib/auth/migrate';
import { createPat } from '@/lib/auth/pat';
import { resetAuthStoreForTests, setAuthStoreForTests, AuthStore } from '@/lib/auth/store';
import { LocalIndexStore } from '@/lib/storage/local-index';
import { resetSessionState } from '@/lib/mcp/session';
import { handleMcpRequest } from '@/lib/mcp/transport';

const service = { listProjects: () => [] } as unknown as MemoryService;
const originalAuthRequired = process.env.AUTH_REQUIRED;

async function setup() {
  const db = new Database(':memory:');
  const index = new LocalIndexStore(db);
  await migrateAuth(index);
  const store = new AuthStore(index);
  setAuthStoreForTests(store);
  await store.createProject('secure-project', 'user-1');
  await store.addMember('secure-project', 'member-1', 'member');
  return { db, store };
}

afterEach(async () => {
  if (originalAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = originalAuthRequired;
  await resetSessionState();
  await resetAuthStoreForTests();
});

test('AUTH_REQUIRED=1 の MCP は project なし tools/list に PAT を要求する', async () => {
  process.env.AUTH_REQUIRED = '1';
  const { db } = await setup();
  try {
    const missing = await handleMcpRequest(new Request('https://example.test/api/mcp', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }), { mode: 'stateless', service });
    expect(missing.status).toBe(401);

    const pat = await createPat('user-1', 'test');
    const allowed = await handleMcpRequest(new Request('https://example.test/api/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + pat.token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    }), { mode: 'stateless', service });
    expect(allowed.status).toBe(200);
  } finally { db.close(); }
});

test('maintenance header の有無は protocol request の先行認可に使わない', async () => {
  process.env.AUTH_REQUIRED = '1';
  process.env.LTM_CURATOR_USER_ID = 'curator';
  const { db } = await setup();
  try {
    const pat = await createPat('curator', 'curator');
    const request = (maintenance?: string) => handleMcpRequest(new Request('https://example.test/api/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + pat.token,
        ...(maintenance ? { 'x-ltm-maintenance-token': maintenance } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    }), { mode: 'stateless', service });
    process.env.LTM_MAINTENANCE_TOKEN = 'maintenance';
    const denied = await request('wrong');
    expect(denied.status).toBe(200);

    const valid = await request('maintenance');
    expect(valid.status).toBe(200);
    delete process.env.LTM_MAINTENANCE_TOKEN;
  } finally { db.close(); }
});

test('member PAT も project 指定なしで tools/list できる', async () => {
  process.env.AUTH_REQUIRED = '1';
  const { db } = await setup();
  try {
    const pat = await createPat('member-1', 'member');
    const response = await handleMcpRequest(new Request('https://example.test/api/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + pat.token },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 4, method: 'tools/list', params: {},
      }),
    }), { mode: 'stateless', service });
    expect(response.status).toBe(200);
  } finally { db.close(); }
});

test('list_projects は memory のない owner/member project だけを内部 UID なしで返す', async () => {
  process.env.AUTH_REQUIRED = '1';
  const { db, store } = await setup();
  try {
    await store.createProject('member-project', 'other-user', '2026-09-26T01:00:00.000Z');
    await store.addMember('member-project', 'user-1', 'member');
    await store.createProject('unrelated-project', 'other-user', '2026-09-26T02:00:00.000Z');

    const request = async (userId: string, id: number) => {
      const pat = await createPat(userId, userId);
      const response = await handleMcpRequest(new Request('https://example.test/api/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + pat.token },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }),
      }), { mode: 'stateless', service });
      expect(response.status).toBe(200);
      return JSON.parse((await response.json()).result.content[0].text) as unknown;
    };

    expect(await request('user-1', 5)).toEqual([
      { project_id: 'secure-project', role: 'owner', created_at: expect.any(String), updated_at: expect.any(String) },
      { project_id: 'member-project', role: 'member', created_at: '2026-09-26T01:00:00.000Z', updated_at: '2026-09-26T01:00:00.000Z' },
    ]);
    expect(await request('member-1', 6)).toEqual([
      { project_id: 'secure-project', role: 'member', created_at: expect.any(String), updated_at: expect.any(String) },
    ]);
  } finally { db.close(); }
});

test('MCPの既定セッションはユーザー間で認証コンテキストを共有しない', async () => {
  process.env.AUTH_REQUIRED = '1';
  const { db, store } = await setup();
  const projectListingService = {
    listProjects: () => [
      { id: 'secure-project', count: 1, updated_at: '2026-09-19T00:00:00.000Z', shared: false },
      { id: 'owner-only-project', count: 1, updated_at: '2026-09-19T00:00:00.000Z', shared: false },
    ],
  } as unknown as MemoryService;
  try {
    await store.createProject('owner-only-project', 'user-1');
    await store.addMember('secure-project', 'user-2', 'member');
    const ownerPat = await createPat('user-1', 'owner');
    const memberPat = await createPat('user-2', 'member');
    const request = (token: string, id: number) => handleMcpRequest(new Request('https://example.test/api/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }),
    }), { service: projectListingService });

    const ownerResponse = await request(ownerPat.token, 10);
    expect(ownerResponse.status).toBe(200);
    expect((await ownerResponse.json()).result.content[0].text).toContain('owner-only-project');

    const memberResponse = await request(memberPat.token, 11);
    expect(memberResponse.status).toBe(200);
    expect((await memberResponse.json()).result.content[0].text).not.toContain('owner-only-project');
  } finally { db.close(); }
});
