import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import { LocalIndexStore } from '@/lib/storage/local-index';
import { migrateAuth } from '@/lib/auth/migrate';
import { AuthStore, resetAuthStoreForTests, setAuthStoreForTests } from '@/lib/auth/store';

const mocks = vi.hoisted(() => ({
  requireWebPrincipal: vi.fn(async () => ({ userId: 'owner' })),
}));
vi.mock('@/lib/auth/clerk', () => mocks);

import * as membersRoute from '@/app/api/projects/[id]/members/route';

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
  const store = new AuthStore(index);
  setAuthStoreForTests(store);
  await store.createProject('project', 'owner');
}

function request(body: object) {
  return new Request('https://example.test/api/projects/project/members', {
    method: 'POST',
    headers: { origin: 'https://example.test', host: 'example.test' },
    body: JSON.stringify(body),
  });
}

test('owner は member の追加・一覧・削除を行える', async () => {
  await setup();
  const context = { params: Promise.resolve({ id: 'project' }) };
  const added = await membersRoute.POST(request({ user_id: 'member' }), context);
  expect(added.status).toBe(201);
  const listed = await membersRoute.GET(request({}), context);
  expect(listed.status).toBe(200);
  expect((await listed.json()).map((member: { user_id: string }) => member.user_id)).toEqual(['member', 'owner']);
  const removed = await membersRoute.DELETE(new Request('https://example.test/api/projects/project/members?user_id=member', {
    method: 'DELETE', headers: { origin: 'https://example.test', host: 'example.test' },
  }), context);
  expect(removed.status).toBe(204);
});

test('member は membership API を変更できない', async () => {
  await setup();
  mocks.requireWebPrincipal.mockResolvedValue({ userId: 'member' });
  const context = { params: Promise.resolve({ id: 'project' }) };
  const response = await membersRoute.POST(request({ user_id: 'other' }), context);
  expect(response.status).toBe(403);
});
