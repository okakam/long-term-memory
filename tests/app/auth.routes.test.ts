import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import { LocalIndexStore } from '@/lib/storage/local-index';
import { migrateAuth } from '@/lib/auth/migrate';
import { AuthStore, resetAuthStoreForTests, setAuthStoreForTests } from '@/lib/auth/store';

const mocks = vi.hoisted(() => ({
  requireWebPrincipal: vi.fn(async () => ({ userId: 'user-1' })),
}));
vi.mock('@/lib/auth/clerk', () => mocks);

import { DELETE, GET, POST } from '@/app/api/auth/tokens/route';
import * as projectsRoute from '@/app/api/projects/route';

let db: Database.Database | undefined;

afterEach(async () => {
  await resetAuthStoreForTests();
  db?.close();
  db = undefined;
  vi.clearAllMocks();
});

async function setup() {
  db = new Database(':memory:');
  const index = new LocalIndexStore(db);
  await migrateAuth(index);
  setAuthStoreForTests(new AuthStore(index));
}

function sameOriginRequest(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: { origin: 'https://example.test', host: 'example.test', ...(init.headers ?? {}) },
  });
}

test('PAT route は発行時に一度だけ token を返し、一覧は hash を返さない', async () => {
  await setup();
  const created = await POST(sameOriginRequest('https://example.test/api/auth/tokens', {
    method: 'POST', body: JSON.stringify({ label: 'CLI' }),
  }));
  expect(created.status).toBe(201);
  const createdBody = await created.json();
  expect(createdBody.token).toMatch(/^ltm_/);

  const listed = await GET();
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual([expect.objectContaining({ label: 'CLI' })]);

  const revoked = await DELETE(sameOriginRequest('https://example.test/api/auth/tokens?token_id=' + createdBody.token_id, { method: 'DELETE' }));
  expect(revoked.status).toBe(204);
});

test('project route は slug を作成ユーザー owner として登録する', async () => {
  await setup();
  const created = await projectsRoute.POST(sameOriginRequest('https://example.test/api/projects', {
    method: 'POST', body: JSON.stringify({ slug: 'new-project' }),
  }));
  expect(created.status).toBe(201);
  const project = await projectsRoute.GET();
  expect(project.status).toBe(200);
  expect((await project.json())[0]).toMatchObject({ project_id: 'new-project', role: 'owner' });
});
