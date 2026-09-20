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

test('AUTH_REQUIRED=1 の MCP は PAT と membership を要求する', async () => {
  process.env.AUTH_REQUIRED = '1';
  const { db } = await setup();
  try {
    const missing = await handleMcpRequest(new Request('https://example.test/api/mcp?project_id=secure-project', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }), { mode: 'stateless', service });
    expect(missing.status).toBe(401);

    const pat = await createPat('user-1', 'test');
    const allowed = await handleMcpRequest(new Request('https://example.test/api/mcp?project_id=secure-project', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + pat.token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    }), { mode: 'stateless', service });
    expect(allowed.status).toBe(200);
  } finally { db.close(); }
});

test('共有書き込みは curator principal と maintenance token の二重条件を要する', async () => {
  process.env.AUTH_REQUIRED = '1';
  process.env.LTM_CURATOR_USER_ID = 'curator';
  const { db, store } = await setup();
  try {
    const pat = await createPat('curator', 'curator');
    const request = (maintenance?: string) => handleMcpRequest(new Request('https://example.test/api/mcp?project_id=__shared__', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + pat.token,
        ...(maintenance ? { 'x-ltm-maintenance-token': maintenance } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
        name: 'remember_user_fact',
        arguments: { name: 'shared-memory', description: 'd', body: 'b', entities: [{ name: 'Entity' }] },
      } }),
    }), { mode: 'stateless', service });
    process.env.LTM_MAINTENANCE_TOKEN = 'maintenance';
    const denied = await request('wrong');
    expect(denied.status).toBe(403);

    const valid = await request('maintenance');
    expect(valid.status).toBe(200);
    delete process.env.LTM_MAINTENANCE_TOKEN;
    void store;
  } finally { db.close(); }
});

test('reindexはproject owner以外のmemberには許可しない', async () => {
  process.env.AUTH_REQUIRED = '1';
  const { db } = await setup();
  try {
    const pat = await createPat('member-1', 'member');
    const response = await handleMcpRequest(new Request('https://example.test/api/mcp?project_id=secure-project', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + pat.token },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'reindex', arguments: {} },
      }),
    }), { mode: 'stateless', service });
    expect(response.status).toBe(403);
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
    const request = (token: string, id: number) => handleMcpRequest(new Request('https://example.test/api/mcp?project_id=secure-project', {
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
